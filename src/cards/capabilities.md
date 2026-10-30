# 卡片分类登记表（`capabilities.json` 的注释本）

JSON 放不下注释，所以登记的结论和理由写在这里。**改 `capabilities.json` 必须同时改这份文档。**

三个轴的定义在 `docs/semantics/mechanism/cards.md`「三个划分轴」。这张表把每张内置卡在三个轴上的取值登记在一处。

- 第一次审阅：2026-09-17，只登记了「依不依赖下层」和「是不是画布卡」。
- 2026-10-12（渲染重构「丁」，`docs/plan/render-refactor-task.md`）：三样登记全，补登记四张，加守门测试。
- 2026-10-13（渲染重构「干净版那一次合入」）：`cardCapabilities` 的写法只取卡的声明；是不是画布卡改由 `surface` 推出，表里的 `canvasHeavy` 删掉。

## 1. 这张表管什么

范围是**内置卡**：`src/cards/index.ts` 里和 `registerCards` 一起注册的四组，现在 101 张。

| 组 | 张数 | 在哪 |
|---|---:|---|
| 自家卡 | 27 | `src/cards/native/` |
| MagicUI | 5 | `src/cards/magicui/` |
| 素材封装卡 | 58 | `src/cards/assets/`，由素材目录生成：Lottie 5 张、粒子 53 张 |
| 探针卡 | 11 | `src/cards/_probe/`，只给探针脚本用 |

用户建的卡（含项目内嵌的卡）不进这张表，见第 8 节。

### 每条登记三样

| 字段 | 轴 | 取值 | 谁说了算 |
|---|---|---|---|
| `writing` | 轴一：哪种写法 | `remotion` / `motion` | **卡的声明**。`remotion` 对应声明里的 `frameMode: "direct"`，`motion` 对应 `"stateful"`。表里登记的值取自声明；两边对不上算错，守门测试会红，改表不改卡 |
| `surface` | 轴二：画在什么上 | `dom` / `canvas2d` / `webgl` / `none` | **这张表** |
| `compositing` | 轴三：依不依赖下层 | `independent` / `sourceDependent` / `belowDependent`，另有两个记号 `unknown`、`fromParts` | **这张表**。源码里写的这三个值一律忽略 |

是不是画布卡由 `surface` 推出：`canvas2d` 或 `webgl` 就是画布卡。旧字段 `canvasHeavy` 不许再写进表里（守门测试拦），经过见第 3 节。

`surface` 的四个值：

- `dom`：画在 DOM 上。SVG 也算（Lottie 用的是 SVG 画法，见 `mechanism/cards.md` 轴二）。
- `canvas2d`：画在 2D 画布上。
- `webgl`：画在 WebGL 上（three.js 等）。
- `none`：没有画面，只出声音的卡。

`compositing` 的取值：

- `independent`：只画自己。可以单独预渲染、经素材服务共享。
- `sourceDependent`：拿指定的另一段画面当输入（转场）。向上追溯整条链路，链上任一控件的参数哈希变了就失效。
- `belowDependent`：毛玻璃、后处理。同一时刻下层任一控件的参数哈希变了就失效。
- `unknown`（记号）：登记了，但**故意不审**。只给三张探针卡用（`r6-unknown`、`probe-css`、`probe-motion-js`），它们的用处就是「一张没审过的卡」。运行时和不在表里一样：按下层依赖卡处理，不进共享缓存、不进流。别的卡不许写。
- `fromParts`（记号）：组合卡 `composite` 专用，轴三由部件推导，见第 6 节。

`context` 是 `sourceDependent` / `belowDependent` 的旧统称，只为读老 `.proc` 里的声明保留，**表里不许写**。

### 通配

键可以写成 `前缀-*`。查表顺序：先精确 id，再取**最长**的 `前缀-*`。
表里只有一条通配 `"particles-*"`，覆盖 53 张粒子素材封装卡。`particles-*` 的前缀带连字符，
所以它**不**匹配通用粒子卡 `particles`（那张单列了一条）。

### 谁在读

- `src/kernel/frameMode.mjs`：`reviewedCard(id)` 把条目原样带出来；`reviewedCanvas(id)` 由 `surface` 推出是不是画布卡；`cardCapabilities` 用其中的 `compositing` 和 `surface`（只用来推出画布与否）。
- `server/vision-project.mjs`：Node 一侧另有一份加载。`reviewedCapabilities(id)` 带出原条目；`reviewedClassification(id)` 把三样整理好（写法、对应的 `frameMode`、画在什么上、是不是画布卡、轴三）。三样的取值表也是那里的常量。

守门测试核对两处查到的是同一份。

## 2. 改这张表会让哪些键变

`cardCapabilities` 的返回整个进卡片身份的摘要（`src/kernel/cardGraph.mjs` 把它写在节点的 `capabilities` 上）。它只有五项：`frameMode`、`need_prerendering`、`compositing`、`canvasHeavy`、`independentCache`。

- **改一张卡的 `compositing` 或画布与否**：这张卡的能力表变了，它的预渲染结果的键、成本键全部换新，旧缓存不再命中。
- **`writing` 不进摘要**：它是登记，写法只取卡的声明。**`surface` 只经「是不是画布卡」这一位进摘要**：`dom` 和 `none` 互换、`canvas2d` 和 `webgl` 互换，摘要不变。守门测试看着 `cardCapabilities` 的返回仍只有那五项。
- **新增条目**：只影响原来查不到、现在查得到的卡。

核对办法：`node scripts/probes/card-table-digest-compare.mjs`，对全部内置卡在基准提交和当前工作区各算一遍能力表、源码版本和三个键，逐张比。改表之后跑一遍，把结果写进报告。

## 3. `frameMode.mjs` 那两处是怎么收掉的

`src/kernel/frameMode.mjs` 在每张内置卡的**源码导入闭包**里（卡片 → `kernel/types.ts` → `frameMode.mjs`，中间只是一句类型导入）。卡片的源码版本是闭包里全部文件的全文（`src/render/cardSourceVersion.mjs`），它进每一个预渲染结果的键，也进卡片声音的身份。所以这个文件**改一个字**，按 id 找得到自己源文件的内置卡的键就全变，已生成的卡片声音被判「已过期，请重新生成」一次（2026-10-12 实测：只加一行注释，42 张的键变了；其余是 58 张素材封装卡和 `composite`，源文件里找不到写死的 id，源码版本走另一条算法，没变）。`src/kernel/cardGraph.mjs` 也在这个闭包里，同理。

2026-10-12「丁」为了不让别的卡换键，这两个文件一个字没动，留下两处不够干净的地方。2026-10-13 用户同意卡片声音过期一次（`docs/plan/user-decisions-2026-10-13.md` 第 1 节第 14 条选乙），在「干净版那一次合入」里一起收掉：

1. **写法只取声明。** `cardCapabilities` 里原有一句旧代码：表里写了 `frameMode` 就拿它盖过卡的声明。这一句删了。表里照旧不许出现 `frameMode` 这个键（写了也没人读），登记写法用 `writing`。
2. **画布卡由 `surface` 推出。** 运行时判画布卡原来读表里的 `canvasHeavy`，和 `surface` 重复。现在 `frameMode.mjs` 的 `reviewedCanvas(id)` 由 `surface` 推出（`canvas2d` / `webgl`），表里的 `canvasHeavy` 删掉，守门测试拦着不许再写。卡片定义上的 `canvasHeavy`（`CardDef.canvasHeavy`）还在：表里不是画布卡或没登记的卡，照旧看卡自己写的这一项（用户卡走这条）。

两处都不改任何一张卡的能力对象（改前改后逐张比过，见 `docs/reports/AGENT-rr-clean.md`）。以后再动这两个文件，同样要先得到用户同意：守门测试 `src/render/audioCardSourceVersion.test.mjs` 钉着。

## 4. 结论汇总（101 张内置卡）

| 写法 | 张数 | 卡 |
|---|---:|---|
| `remotion` | 11 | `caption-track`、`av-pulse`、`sound-notification`、`sound-keyboard`、`probe-slow`，以及 Lottie 的 6 张：`lottie`、`lottie-adrock`、`lottie-bodymovin`、`lottie-gatin`、`lottie-happy2016`、`lottie-navidad`（2026-10-13 渲染重构「癸」把声明改成 remotion 式） |
| `motion` | 90 | 其余全部 |

| 画在什么上 | 张数 | 卡 |
|---|---:|---|
| `dom` | 43 | 除下面三行之外的全部（含 Lottie 的 6 张） |
| `canvas2d` | 55 | 通用粒子卡 `particles`、53 张粒子素材封装卡（通配）、探针卡 `r6-canvas` |
| `webgl` | 1 | `scene-3d` |
| `none` | 2 | `sound-notification`、`sound-keyboard` |

| 依不依赖下层 | 张数 | 卡 |
|---|---:|---|
| `independent` | 85 | 除下面三行之外的全部 |
| `belowDependent` | 12 | 12 张用 `hud-glass` 的自家卡 |
| `sourceDependent` | 0 | 内置卡里现在没有「拿另一段画面当输入」的 |
| `unknown`（故意不审） | 3 | `r6-unknown`、`probe-css`、`probe-motion-js` |
| `fromParts` | 1 | `composite` |

表里还有一条不属于这 101 张的：`mu-animated-shiny-text`。它是随仓库带的一张 `src/cards/user/` 下的卡（原先算在 MagicUI 里），登记保留，三样照它的声明和画法填。

## 5. 判据

**`belowDependent` 的唯一来源是 `hud-glass`。** `src/cards/native/hud.css` 的 `.hud-glass`
带 `backdrop-filter: blur(var(--pc-glass-blur, 24px))`，它采样自己身后已经合成好的画面，
所以下层任何一张卡的参数变了，这张卡的预渲染结果就不作数。全仓库 `backdrop-filter` 只有这一处。
用 `className="hud-glass"` 的正好 12 个卡片文件。

**读像素零命中。** `getImageData`、跨层 `drawImage(` 在 `src/cards` 下没有卡片使用。
`scene-3d.tsx` 里出现的 `drawImage(canvas)` 是注释，讲的是**编辑器**去读这张卡的画布，
方向相反，不构成对下层的依赖。

**画布卡的判据是「画面载体是 canvas / WebGL」**，不是「重」。
`particles`（tsParticles，2D 画布，声明里 `canvas.kind` 是 `dom2d`）和 `scene-3d`（three.js，WebGL，`canvas.kind` 是 `three`）；
`terminal-3d` 的立体感来自 CSS 透视，**没有 canvas**；Lottie 用的是 SVG 画法，按 DOM 卡算；
`focus-card` 里的是 `<video>`，不是 canvas。卡片声明了画布契约（`canvas`）的，表里的 `surface` 要和它对得上，守门测试核对。

**自身 `filter: blur()` 不算依赖下层。** `punch-pill.tsx` 和 `blur-text.tsx` 的 `blur()`
模糊的是自己的元素，不采样身后画面。`blur-text` 判 `belowDependent` 是因为它另外用了 `hud-glass`，
不是因为这个 `filter`。

**写法不在这里判。** 写法取自卡的声明；声明对不对由建卡检查和卡片作者负责。

### 逐张

**MagicUI（5 张，全是 `motion` / `dom` / `independent`）**

| id | 理由 |
|---|---|
| `mu-number-ticker` | Motion 弹簧改数字，纯 DOM 文本 |
| `mu-blur-fade` | Motion 对自身做 `filter: blur` 加位移，不采样身后 |
| `mu-circular-progress` | rAF 插值加 SVG 描边 |
| `mu-typing` | rAF 改已显示字符，纯文本 |
| `mu-word-rotate` | AnimatePresence 换词 |

`mu-animated-shiny-text`（`src/cards/user/` 下那张）：CSS 关键帧高光，`background-clip` 作用在自己身上，同上三样。

**自家卡（27 张）**

| id | 写法 | 画在什么上 | 依不依赖下层 | 理由 |
|---|---|---|---|---|
| `composite` | motion | dom | `fromParts` | 见第 6 节 |
| `lottie` | remotion | dom | independent | `LottieView` 走 SVG 画法，只画自己。每一帧把 `t` 换算成帧号直接跳过去；播放库里的随机数和「属性值留旧数」在 `loadLottie` 里固定住了，顺着推和直接跳是同一个画面（2026-10-13 改登记） |
| `particles` | motion | canvas2d | independent | tsParticles 画在自己的画布上；画布不透明区之外是透明的，不读下层 |
| `scene-3d` | motion | webgl | independent | three.js WebGL，按 `t` 算姿态后显式渲染；只画自己 |
| `caption-track` | remotion | dom | independent | 纯文本字幕；虽然引了 `hud.css`，但没有用 `hud-glass` |
| `av-pulse` | remotion | dom | independent | 一个按 `t` 算大小和不透明度的圆环（自己的边框），不采样身后；同片段另有声音（2026-10-12 补登记） |
| `sound-notification` | remotion | none | independent | 只有 `audio()`，没有画面（2026-10-12 补登记） |
| `sound-keyboard` | remotion | none | independent | 同上（2026-10-12 补登记） |
| `entity-chips` | motion | dom | independent | 引了 `hud.css`，用的是定位类，不是玻璃板 |
| `pin-board` | motion | dom | independent | 同上 |
| `punch-pill` | motion | dom | independent | 同上；`filter: blur(32px)` 是自己的辉光底 |
| `quote-lockup` | motion | dom | independent | 同上 |
| `type-shift` | motion | dom | independent | 同上 |
| `ui-callout` | motion | dom | independent | 同上（DOM 加 SVG 引导线） |
| `focus-card` | motion | dom | independent | 人物窗口用 `<video>` 加 Motion，画自己。放的是它自己参数里的素材，不是别的片段的画面，所以不是 `sourceDependent` |
| `blur-text` | motion | dom | **belowDependent** | 用了 `hud-glass` |
| `chapter-bar` | motion | dom | **belowDependent** | 同上 |
| `checklist` | motion | dom | **belowDependent** | 同上 |
| `growth-curve` | motion | dom | **belowDependent** | 同上 |
| `odometer` | motion | dom | **belowDependent** | 同上 |
| `rank-bars` | motion | dom | **belowDependent** | 同上 |
| `ring-metric` | motion | dom | **belowDependent** | 同上 |
| `stat-proof` | motion | dom | **belowDependent** | 同上 |
| `step-timeline` | motion | dom | **belowDependent** | 同上 |
| `term-card` | motion | dom | **belowDependent** | 同上 |
| `terminal-3d` | motion | dom | **belowDependent** | 同上；它的 3D 是 CSS 透视，不是 canvas |
| `versus-card` | motion | dom | **belowDependent** | 同上，两块玻璃板 |

**Lottie 素材封装卡（5 张，全是 `remotion` / `dom` / `independent`）**

`lottie-adrock`、`lottie-bodymovin`、`lottie-gatin`、`lottie-happy2016`、`lottie-navidad`。
五张共用 `LottieView`（SVG 画法），各自只画自己的动画，互不采样，也不是画布卡。写法跟着通用 Lottie 卡，2026-10-13 一起改成 remotion 式。

**粒子素材封装卡（53 张，通配 `particles-*`，全是 `motion` / `canvas2d` / `independent`）**

53 张全部共用 `ParticlesView` 加 `translateParticlesConfig`，差别只在 JSON 配置：同一个渲染器、
同一块自有画布、同一套「只画自己」的结论，声明也是同一段代码生成的，所以合并成一条通配。

> 配置名里的 `mouse*`、`clickPause`、`lightHover` 是上游示例的交互演示。舞台上没有鼠标，
> 这些交互不触发；它们仍然只画自己的画布，`independent` 不受影响。

**探针卡（11 张）**

| id | 写法 | 画在什么上 | 依不依赖下层 | 说明 |
|---|---|---|---|---|
| `probe` | motion | dom | independent | 一个绝对定位的文本 div |
| `probe-countdown`、`probe-typewriter` | motion | dom | independent | 定时器探针，只画自己的文本 |
| `probe-slow` | remotion | dom | independent | 可调成本的探针卡（每次渲染忙等 `burnMs` 毫秒），只画自己那一块色块（2026-10-12 补登记） |
| `probe-slow-stepped` | motion | dom | independent | 上一张的推帧版，画法相同 |
| `r6-stateful`、`r6-huge` | motion | dom | independent | 只画自己 |
| `r6-canvas` | motion | canvas2d | independent | 自己的一块 2D 画布 |
| `r6-unknown` | motion | dom | `unknown` | 故意不审：探针要一张「没审过的卡」 |
| `probe-css`、`probe-motion-js` | motion | dom | `unknown` | 故意不审：这两张要走「按下层依赖卡处理、判轻就活渲」那条路 |

## 6. 组合卡

`composite` 在表里登记成 `fromParts`：轴三由部件树推导，最保守者胜
（保守程度 `independent` < `sourceDependent` < `belowDependent` < `context` < `unknown`）。
实现：`frameMode.mjs` 的 `derivedCompositing(parts)` 加 `DERIVED_FROM_PARTS`。登记进表没有改变推导：`fromParts` 不是审阅结论，`cardCapabilities` 照旧走推导。

推导拿的是**部件出处的卡 id**（`PartDef.from`）。
但是 `clip.parts` 上存的是 `PartInstance.partId`（部件 id），要换成卡 id 得查部件注册表
（`src/kernel/partRegistry.ts`，只有浏览器侧的 `.tsx` 能加载）。`cardGraph.mjs` 两端都跑，
**不能一端查得到、一端查不到**，否则身份摘要会在浏览器和 Node 之间分叉。
所以 `cardGraph.mjs` 只把 `clip.parts` 原样传进去，解析不出卡 id 的部件按 `unknown` 计：

- 没有部件的组合卡（只有占位文字）是 `independent`；
- 有部件的组合卡是 `unknown`，等把部件注册表接到两端之后再收紧。

`surface` 登记的是 `dom`：组合卡现在一律不当画布卡处理，部件里有画布也一样。

真出现「表里说 independent、实际却有毛玻璃」的情况，由第 7 节的运行期兜底接住。

## 7. 运行期兜底

`src/render/capabilityGuard.ts` 在卡片挂载后扫一遍子树的计算样式，
量到 `backdrop-filter !== 'none'` 而表里说 `independent` 的，`console.warn` 并调
`degradeCard(id)`。`cardCapabilities` 读这张降级表，本次会话内把它当 `belowDependent`。
只在开发模式、且地址上没有 `export=` / `frames=` / `bake=` 时才跑；
每张卡只量一次。导出、预渲染、生成快照那条路上一个 `getComputedStyle` 都不会执行，逐像素基线不受影响。

## 8. 不在这张表里的卡

**用户建的卡、项目内嵌的卡。** 这份表随仓库发布，不能被某一台机器上的项目改写。它们的写法取自源码里的声明；
依不依赖下层一律当 `unknown`，比审过的结论更保守，不会画错，只是不进共享缓存。审阅结果随源码同步是 `docs/plan/TODO.md` 里另立的专项。

**部件（`src/parts/lib/*`）** 不是卡片定义，不进这张表；它们的轴三经第 6 节的推导从出处卡带过来。

## 9. 新增或改一张内置卡时

1. 在 `capabilities.json` 里加一条，三样写全（不写 `canvasHeavy`）。素材封装卡的 id 落在已有通配里就不用加。
2. `writing` 照卡的声明填。之后改了卡的声明，表跟着改。
3. `compositing` 要有审阅结论，照第 5 节的判据审，把理由写进本文档的逐张表。
4. 跑守门测试 `node --test src/cards/capabilities.test.mjs`。没登记、三样不全、写法和声明对不上、画在什么上和卡的声明打架、表里写了 `frameMode` 或 `canvasHeavy`、表里有对不上任何卡的键，它都会红。
5. 改了现有卡的 `compositing` 或画布与否，跑第 2 节的比对脚本，把哪些卡的键变了写进报告。

# 预渲染页驱动协议（bake page protocol）

预渲染页（`?export=1`，`src/ExportView.tsx`）从打开到逐帧的**全部页内调用**就是这份协议。
Node 侧只经 `window.__*` 驱动页面，除此之外不碰页面内部；页面侧不知道是谁在驱动它。

清单由 `scripts/verify-bake-protocol.mjs` 守住：它扫 `server/bakery/` 的 `chrome.mjs`、`bake.mjs`、`shards.mjs`、`media.mjs`、`ffmpeg.mjs`、`export.mjs`、`audio-mix.mjs`、
`frame-ready.mjs`、`capture-frame.mjs`、`frame-media.mjs` 里全部
`window.__…` 的读写，不在下面两栏里的名字直接失败（两栏和脚本必须字字对上）。
`npm test` 里的落点是 `server/test/bake-protocol.test.mjs`。

**舞台页也提供 `__pcCreateSnapshot`**（`src/StageView.tsx`，和导出页同一份 `src/render/createSnapshot.ts`；
两页的场景根都是 `[data-pc-scene]`）。K1 探针、`probe-frame`、生成快照的三段耗时、L1 都在舞台页调它。

## HTML 路必需

只用这一栏就能把一帧从「页面刚打开」推到「一份自给自足的 HTML 快照」。
这一栏里的每一步都必须是页面宿主（浏览器里的离屏 iframe、在线浏览器模式）自己做得到的，
**不允许出现只有 puppeteer 能做的步骤**。

| 名字 | 谁调 | 做什么 |
| --- | --- | --- |
| `__pcReady` | `chrome.mjs`（`waitReady`；`newSession` 等它，`openBakery` 经它建页） | 页面装配完毕的信号，布尔量 |
| `__pcLoadProject` | `chrome.mjs`（`loadProject`） | 原地换项目文档，不重新导航 |
| `__pcTimeline` | `bake.mjs`、`shards.mjs` | 摊平后的时间轴（fps / duration / clips），分片规划要读 |
| `__pcPlanFrameWindow` | `bake.mjs` | 一批帧要挂哪些片段、时钟拨到哪一帧（`render/frameWindow.mjs`） |
| `__pcSetFrameWindow` | `bake.mjs` | 按上面的计划重挂场景，并把时钟拨到挂载帧 |
| `__pcHideFrameMedia` | `bake.mjs`（`step()` 的开头） | 摘掉素材层的 `src`：推进动画的过程中一律不加载素材 |
| `__pcPrepareFrameMedia` | `frame-media.mjs` 的 `prepareFrameMedia`（`bake.mjs` 与 `capture-snapshot.mjs`） | 按 `data-pc-media-*` 把这一帧的素材装回来并 seek 到位 |
| `__pcSetT` | `bake.mjs` | 下发这一帧的时间（写 `__pcExportMs` + `flushSync` 提交） |
| `__pcSyncAnims` | `bake.mjs` | 把所有 Web Animations 的 `currentTime` 钉到导出时间 |
| `__pcStaticProbe` | `bake.mjs` | 这一帧画面静不静止（静止才敢复用上一帧） |
| `__bfSettle` | `frame-ready.mjs`、`bake.mjs` | 排空挂着的宏任务，直到 DOM 不再变 |
| `__pcFrameReady` | `frame-ready.mjs`（`waitFrameReady`） | 控件 / 字体 / 图片就绪 |
| `__pcFrameWorkStatus` | `frame-ready.mjs`、`capture-frame.mjs` | 还有哪些异步加载没落地（超时报错要用） |
| `__pcRestartCards` | `bake.mjs`（`warmUp`） | 重挂载全部卡片（随机种子先拨回起点） |
| `__pcResetAnims` | `bake.mjs`（`warmUp`） | 清空动画锚点 |
| `__pcClipFrameModes` | `shards.mjs`、`export-unified.mjs`（并行分片的规划步） | 每个卡片片段的帧模式，用来选安全的分片切点 |
| `__pcCreateSnapshot` | `bake.mjs`（`shoot()` 与逐帧循环） | 把 `[data-pc-scene]` 生成快照 `{ html, lossy, controls, timing }` |

## PNG 路 / puppeteer 专用

这一栏只服务「直接出像素」那条路：它要么依赖 CDP（`Page.captureScreenshot`、
`HeadlessExperimental.beginFrame` 的虚拟时间），要么只是给 Node 侧看的计数器/诊断量。
页面宿主没有它们也能走完 HTML 路。

| 名字 | 谁读 | 做什么 |
| --- | --- | --- |
| `__pcMutationCount` | `bake.mjs`（只读） | DOM 变动计数，静态判定 |
| `__pcExportMs` | `capture-frame.mjs`（只读） | 当前帧的导出毫秒，截图前核对页面时钟 |
| `__pcRafCount` | `bake.mjs`（只读） | 被计数的 rAF 注册次数，静态判定 |
| `__pcProbeMs` | `bake.mjs`（只读，`trace`） | 探针耗时，只用于 trace |
| `__bfGlassOn` | `chrome.mjs`（注入）、`bake.mjs`（调用） | 毛玻璃遮罩：把除玻璃外的一切藏起来、玻璃涂白 |
| `__bfGlassOff` | `chrome.mjs`（注入）、`bake.mjs`（调用） | 撤掉遮罩，分两步还原以免惊动动画 |
| `__bfGlassEls` | `chrome.mjs` | 遮罩期间被标记的元素表（`__bfGlassOn` / `Off` 之间传递） |
| `__pcAudioMix` | `audio-mix.mjs` | 音轨混音（`?audioMix`），不参与画面 |

外加不带名字的两样，也只在这条路上：`captureFrame` 的 `Page.captureScreenshot`，
以及 `HeadlessExperimental.beginFrame` 推进的 CDP 虚拟时间。

## rAF 与 CDP 虚拟时间的确定性差异（记录，不在本任务解决）

Node 侧推进一帧靠 `beginFrame`：渲染器不自己出帧（`--enable-begin-frame-control`），
每一拍都由 Node 显式发起，这一拍里的 `document.timeline` 前进多少由 CDP 决定。
**同一份卡片代码，同一个 t，连发两趟得到的是逐字节相同的画面。**

页面宿主（在线浏览器模式的离屏 iframe、舞台页）没有 CDP，它推进时间的办法是
`__pcSetT` → 等一次真实 rAF → `__pcSyncAnims`。两者的差别：

- 真实 rAF 的间隔取决于机器负载和显示器刷新率，而 `beginFrame` 的一拍是名义值（`1000/60`）。
  `__pcSyncAnims` 把 WAAPI 动画的 `currentTime` 显式钉到 `__pcExportMs`，所以**能被钉住的动画**
  两条路一致；`__pcExportMs` 之外自己累积状态的 JS（Motion 的 spring / 粒子）不一致。
- `beginFrame` 保证「这一拍的合成结果」和截图是同一帧；真实 rAF 下合成时机由浏览器决定，
  页面宿主只能靠 `__bfSettle` + `__pcFrameReady` 把异步落地，落不到「像素级同一帧」这么紧。
- 资源加载期间 Chrome 的虚拟时间会偷偷快进，所以任何「现在几点」都走 `clockNow()`
  （`src/kernel/clock.ts`）而不是 `performance.now()`——这条两条路共用。

结论：HTML 路（生成的快照）在两条路上等价，因为快照里已经没有任何还在走的钟；
**逐帧推进过程**的确定性只有 CDP 那条路是保证的。页面宿主要拿到同等确定性，
需要给它一条「虚拟拍」的等价物，这不在本任务范围内。

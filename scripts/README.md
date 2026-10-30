# 渲染内核脚本

0.4 起导出后端是 chrome-headless-shell 的 `HeadlessExperimental.beginFrame`。为什么换、换了多少,见
`docs/archive/topics/render-rebuild-plan.md`;旧的 CDP 虚拟时间后端归档在 `scripts/archive/`(仍可单独运行,用来对账)。

**渲染引擎本身不在 `scripts/` 里**:它是 `server/bakery/`(见 `server/bakery/index.mjs` 的模块划分)。
`scripts/export-frames.mjs` 只是命令行入口 —— 解析参数、调 `exportFrames`,用法和输出一如既往。
仓库内要用引擎,直接 import `server/bakery/…`,不要经过 `scripts/export-frames.mjs`。

## 用法

先起 dev server(任意端口),导出视图用 `/?export=1`(或原型入口 `proto.html?export=1`)。

```bash
node scripts/export-frames.mjs --url "http://127.0.0.1:5197/?export=1" --frames 0-59 --out out/smoke --no-video
```

| 参数 | 说明 |
|---|---|
| `--url` | 导出视图地址。可带 `&timeline=<url>` 指定时间轴(Timeline 或 Project 形状;data URL 也行) |
| `--frames a-b` | 只落盘这一段;时间仍从第 0 帧顺序推进(动画锚点、按 delta 积分的卡片、随机数流都依赖前面推过哪些帧) |
| `--target-frames a,b,c` | 只截这几帧(离散取样,给预渲染用),一趟推过去沿途截 |
| `--out` | 输出目录,帧在 `<out>/frames/%06d.png` |
| `--fps` | 覆盖时间轴 fps |
| `--warm` | 预热帧数,默认 3 |
| `--format png\|jpeg` / `--quality` | 默认 PNG(带 alpha,optimizeForSpeed:仍无损,只是压得快、文件大) |
| `--static-skip` | 画面静止的帧复用上一张,每 10 帧强制真截一张比对 |
| `--dom-cache` | 同时把每帧舞台生成 HTML 快照 存到 `<out>/dom/`,供 `replay-frames.mjs` 乱序重截 |
| `--workers N\|auto` | 分片并行,默认 `auto`（按 CPU/内存取 1~4）。每个分片独立 Chrome + ffmpeg 写入 `parts/*/overlay.mov`,完成后用 concat 无损合成；仍在安全卡片边界切段 |
| `--media ffmpeg\|chrome` | 素材(视频 / 图片)怎么进成片。默认 `chrome`:预览、导出、`see_frames` 共用 Chrome FrameScene；`ffmpeg` 是兼容旁路，页面只渲卡片(`&cardsOnly=1`)，素材由 ffmpeg 合进 `preview.mp4`(`server/export-compose.mjs`) |
| `--audio ffmpeg` | 声音不走 Chrome 混音(默认在 OfflineAudioContext 里混,带音频效果,和预览同一套节点图),改用 `server/bakery/mux-audio.mjs` 的 ffmpeg 滤镜图直接混,没有效果;对账用 |
| `--no-video` | 跳过 ffmpeg 合成(帧照样只有卡片,除非 `--media chrome`) |
| `PC_EXPORT_TRACE=1` | 每帧把页面时钟和全部动画状态记到 `<out>/trace.json`,排查确定性用 |
| `PC_EXPORT_VERBOSE=1` | 每帧打印进度 |
| `PC_CHROME_ARGS="…"` | 追加 Chrome 启动参数(排查用;只透传,不要用来关 TLS 校验,见「测法」) |

不带 `--no-video` 时用 ffmpeg 合成:

- `<out>/overlay.mov`:ProRes 4444 带 alpha,**只有卡片层**(拿去叠在别的画面上用的那一层;以前素材也烤在里面);
- `<out>/preview.mp4`:成片。灰底 → 素材层(按 `clip.frame` 摆位、cover 铺满、不透明度 × 淡入淡出、交叉溶解)→ 卡片层,再混音轨。
  素材层的规则和预览 `MediaLayers` 一致,细节(取帧、强调、毛玻璃)见 `server/export-compose.mjs` 文件头。
  卡片上的毛玻璃(`backdrop-filter`)在只渲卡片时模糊不到视频:底下有素材的帧会多截一张玻璃遮罩(`<out>/glass/`),
  ffmpeg 按遮罩把素材那层模糊后混回去。进度分两步报:`Exported frame i (k/N)` 是渲卡片,`Composited frame k/N` 是合成。

找不到 chrome-headless-shell 时会自动装进 `PUPPETEER_CACHE_DIR`(桌面版 = `runtime/chrome`)再重试 ——
从 0.3.x 打补丁升上来的用户手里没有它(补丁只带 `runtime/app`)。

## 其他脚本

| 脚本 | 做什么 |
|---|---|
| `verify-determinism.mjs` | 同一段导两遍到 `out/verify-a` / `out/verify-b`,逐像素比对,全部相同退出码 0 |
| `replay-frames.mjs --cache <out>/dom --out <dir> [--frames a-b] [--shuffle]` | 从 HTML 采样缓存乱序重截,不需要从第 0 帧顺推 |
| `font-audit.mjs` | 查每个文本节点实际用到的字体,落进系统回退(白名单以外)就报出来 |
| `card-audit.mjs` | 逐张卡查位置无关、确定性、DOM 结构稳定、挂载时的网络请求、画面载体 |
| `prune-prerender-cache.mjs [--apply] [--root <帧库>] [--before <时刻>]` | 清掉帧库里 M4 换键之后不再被引用的旧缓存目录(快照、PNG、流、轨道前缀、整场景缓存),按「目录里最新的文件早于分界」判旧;缺省只列出,加 `--apply` 才删 |
| `archive/export-frames-virtual-time.mjs` | 旧后端,只留作对账 |
| `archive/probes/` | 已退役的探针:验的行为已经不是产品现在的行为,留作对账;每条写了接替它的是谁,见 `archive/probes/README.md` |
| `diaglog.py <报告> overview\|anomalies\|pages\|page N\|show I\|find RE\|env\|split` | 读「对话诊断」报告(一两 MB 的单个 JSON):总表、异常归类、按页读、拆成小文件;也能 `from diaglog import load` 当对象用。`py -3` 跑,用法见文件头 |

**做逐帧对账之前先读 [`docs/guides/compare-pitfalls.md`](../docs/guides/compare-pitfalls.md)。** 里面记着「画面看着一样,程序却说不一样」的几种成因:预热截图错位、样式写法、属性顺序、浮点末位、WAAPI 和 JS 两条动画路径的差别、被钉住的时钟、纯 DOM 环境的坑、实验服务器改写全局端口文件。

## 确定性模型(beginFrame 后端)

每帧:`__pcSetT(sec)` → 等网络 → 排空 → **beginFrame 推一拍** → 等网络 → 排空 → `__pcSyncAnims()` → 排空 → 等素材 → **beginFrame 截图**。

1. **页面时钟量化**(`src/kernel/exportClock.ts`):`performance.now()` 和 rAF 时间戳都返回当前帧的导出毫秒。beginFrame 的帧时间只要单调递增,画面不读它。
2. **随机数和墙上时钟钉死**(`src/kernel/pinEntropy.ts`,在所有 import 之前装):`Math.random` 带种子、`Date.now()` / `new Date()` = 固定纪元 + 当前帧毫秒、`crypto` 走同一个种子。第三方库在模块加载时抓走的随机源也罩得住(实测 lottie 的 wiggle / random 表达式导两遍从 89/90 帧不同变成 0)。
3. **Web Animations 钉时间**(`ExportView.tsx` 的 `__pcSyncAnims`):每帧把每个动画 `pause()`,`currentTime` 设为「导出毫秒 − 该动画首次出现那一帧的导出毫秒」;越过结尾的 `finish()`。
4. **等网络**:Network 域数在路上的请求,清零才推下一拍。缺了它,提前挂载那一帧动态 `import("three")` 还没回来,三维画面晚一帧(实测)。
5. **排空**:页面内 `setTimeout(0)` 直到 `__pcMutationCount` 不再变,React 经 Scheduler 排的提交在这里落地。
6. **软件光栅化**:GPU 光栅化在旋转/缩放的抗锯齿边缘上两次不完全一致,加 `--disable-gpu` 等参数后逐像素相同。
7. **字体不交给系统挑**:字体栈没覆盖到的字形,不同 Chrome 构建会选不同的回退字体(实测 ✓、等宽数字、等宽栈里的中文都中过)。主题字体栈显式列全,`font-audit.mjs` 零告警。
8. **重挂载用 flushSync**:预热后 `__pcRestartCards` 同步重挂载全部卡片,第 0 帧的动画锚点才固定。

## 实测(2026-09-10,30fps,1920×1080,i7-14700KF)

| 场景 | 结果 |
|---|---|
| demo 全长 1800 帧 | 旧后端 107.7 ms/帧 → 这里 26.9 ms/帧;自己连导两趟 1800/1800 相同 |
| demo 0~20 秒 + 粒子 + scene-3d,600 帧,新旧对账 | 587/600 相同;其余 13 帧是旧后端自己的偶发两态(它两趟之间也差这 13 帧) |
| 分片 1 / 4 / 8 个进程 | 54.8s / 44.8s / 62.4s,三者两两 1800/1800 相同 —— 推进省不掉、多个软件光栅化进程互抢 CPU |
| `--dom-cache` 300 帧 | 生成快照约 +56 ms/帧,带粒子 / 三维画布时约 333 KB/帧(画布存成 PNG);乱序 vs 顺序重放 300/300 相同 |
| 重放 vs 实时截图 | 不是逐字节相同(边缘有细小残差,旋转元素最明显),所以同一次交付只走一条路 |

## 测法

各种手动测法先记在这里。哪一种做成了一条命令能跑的脚本，就把对应的这段换成那条命令。验证的规则在 `docs/semantics/guide_files/verification.md`，按症状排障在 `docs/guides/troubleshooting.md`。

### 编辑器的地址参数

- `?editor`：直接进编辑器，不停在开始页。
- `?open=<.proc 的绝对路径>`：先复制一份再打开，和双击文件同一条路。
- `?nosetup=1`：不弹首次 AI 设置对话框。

### 驱动编辑器页面

- 用页面同一个源动态引入（如 `await import('/src/store/project.ts')`），拿到的就是页面正在用的那份模块。`window.__pcPreviewAudio()` 返回接进 Web Audio 的元素数。

### 导出端到端

`node scripts/export-e2e.mjs --project <project.json> [--frames a-b] [--determinism] [--media-lib]`，用法和坑见文件头。

### 给探针起的 Chrome 加启动参数

`PC_CHROME_ARGS="--flag-a --flag-b"` 只把参数原样透传给探针（以及预渲染）起的 Chrome，不做别的。典型用途是云端 Linux 以 root 运行要 `--no-sandbox`。不要用它关 TLS 校验（如 `--ignore-certificate-errors`）：对远端站点的探针会在证书有问题时照样通过，掩盖真问题；代理重新签发证书的环境按信任代理的 CA 办。

### 长时间真跑审查环路

`node scripts/review-loop-run.mjs --prompt "<消息>"`，一趟约 600 万输入 token，真跑前先和用户确认；用法和坑见文件头。

### 不用真模型测 AI 栏卡顿

- 在 `evaluateOnNewDocument` 里替换 `window.fetch`：`/api/ai/providers` 回一个可用的 provider，`/api/ai/chat` 回一个按节奏吐 SSE 的流。
- 先设 `localStorage.aiViewMode = 'verbose'`，否则回复原文不进 DOM。
- 用 PerformanceObserver 的 longtask 加 50 ms 定时器的漂移量主线程。灌完项目先等 3 秒没有长任务再发。

### 壳内 Agent 浏览器

Agent 的浏览器是桌面壳主窗口里的子 webview，靠 WebView2 的远程调试端口让 puppeteer 连上。测它不用打包：

1. 设 `PROMPTCUT_AGENT_CDP=9333`，把仓库的 vite 起在 5210。壳探到 5210 上已有 PromptCut 就不再起自己的 sidecar。
2. 同样设 `PROMPTCUT_AGENT_CDP=9333`，再设 `PROMPTCUT_RUNTIME_DIR=desktop/src-tauri/runtime`，启动 `desktop/src-tauri/target/debug/promptcut.exe`。
3. `http://127.0.0.1:9333/json/list` 里出现 `about:blank#promptcut-agent` 就连通了。用 puppeteer 的 `connect({ browserURL })` 驱动编辑器页面，再 `POST 5210/api/mcp/call` 调 `web_handoff` 看效果。

壳启动后窗口可能是最小化的，要还原窗口才截得到图。测完关掉 debug exe。

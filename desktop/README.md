# PromptCut Desktop

PromptCut 的 Tauri v2 桌面壳。把编辑器和它依赖的全部运行时——Node、Chrome for Testing、ffmpeg、内置 Python——打成一个 Windows x64 NSIS 安装包。用户双击安装、双击图标就能用，不需要自己装 Node、浏览器或 Python。

## 为什么要把 Node 打包进去

PromptCut 的后端逻辑写在 `vite.config.ts` 的几个插件中间件里（AI 桥、导出、语音转文字）。`vite build` 产出的是纯静态文件，没有这些接口。运行时必须真起一个 Vite dev server，所以安装包里自带了完整的 Node 和项目源码副本，由 Rust 壳以 sidecar 方式启动。

## 构建环境

| 项目         | 版本                                                            |
| ------------ | --------------------------------------------------------------- |
| Node.js      | ≥ 22（推荐 24.x）                                               |
| Rust         | stable msvc（`rustup default stable-x86_64-pc-windows-msvc`）    |
| VS Build Tools | 「使用 C++ 的桌面开发」工作负载                                   |
| WebView2     | Windows 10/11 自带；若缺失，安装包会自动下载 bootstrapper         |
| ffmpeg       | `winget install --id Gyan.FFmpeg -e`                             |
| Tauri CLI    | `npm i`（已在 devDependencies 中）                               |

## 构建步骤

```powershell
cd desktop

# 1. 安装 Tauri CLI
npm install

# 2. 组装 runtime/（复制 app 源码 + npm ci + vite build + Chrome + ffmpeg + node sidecar）
npm run prepare-runtime

# 3. 组装内置 Python（另一个任务负责的脚本）
npm run prepare-python

# 4. 构建安装包（Rust 编译 + NSIS 打包）
npm run build
```

> **首次构建说明**
>
> - `prepare-runtime` 首次运行需要复制 Chrome for Testing（约 500 MB），后续幂等运行会快很多。
> - Rust 首次编译 Tauri 及其依赖约 5–15 分钟，后续增量编译很快。
> - 构建产物在 `src-tauri/target/release/bundle/nsis/` 下。

## 发布：安装包 + 更新补丁 + 拓展库包

日常改动绝大多数只落在 Node 那一半（`src/`、`server/`、`dist/`），Rust 壳和
Chrome / ffmpeg / Python 三个大块一动不动。完整安装包压出来 320 MB（装开约 1 GB），
而这些改动本身通常只有几 MB。加上可选能力那些几十 MB 的依赖和模型，一共三种产物：

```powershell
cd desktop
npm run release -- --from-head    # 推荐：源码取自 HEAD
npm run release                   # 源码取自当前工作区
```

`--from-head` 会先从 HEAD 开一棵临时 worktree 当源码，产物因此一定对应某个
commit，而不是把工作区里未提交的东西一起发出去（多人同时改一个工作区时尤其
要紧）。被排除的文件会在日志里逐条列出来。只有源码走 worktree，Chrome /
ffmpeg / Python / Rust 编译缓存还是用 `desktop/` 下原来那份，不会因此变慢。

| 产物                                     | 大小    | 什么时候用                                   |
| ---------------------------------------- | ------- | -------------------------------------------- |
| `release/PromptCut-<版本>-setup.exe`     | ~320 MB | 第一次安装；内核代次变了；补丁装不上时的兜底 |
| `release/PromptCut-patch-<版本>.exe`     | 几 MB起 | 已经装过，只是更新 Node 那半边               |
| `release/extensions/PromptCut-ext-<名字>-<版本>.exe` | 50~330 MB | 可选能力（语音识别 / 镜头识别 / 运动追踪），按需装 |

前两个都是 exe，用户双击就装，不用先解压。补丁那个是 NSIS 自解压壳：把内容解到
`$PLUGINSDIR`（NSIS 退出时自动清，不会在 `%TEMP%` 留几百 MB 残骸），然后运行
`apply-patch.ps1`。它会核对安装位置和内核代次、关掉正在运行的程序（只认可执行
文件在目标目录下的那些）、备份当前版本再覆盖，逐个文件校验 SHA-256，任何一步
出错都回滚。`exports`（导出的视频）、`.pc-chats`（AI 会话历史）、
`%LOCALAPPDATA%\promptcut`（设置和密钥）和下载的语音模型都不在作用范围内。

补丁 exe 接受和脚本一样的参数，装在非默认位置时用得上：

```powershell
PromptCut-patch-0.2.3.exe -InstallDir "D:\PromptCut"
PromptCut-patch-0.2.3.exe -WhatIf          # 只检查，不写入
```

### 版本号怎么排

两个版本号的进位规则和 `minShellVersion` 的用法在 `docs/semantics/guide_files/git_and_release.md`。下面「一次教训」是这条规则的来历。

### 一次教训：别拿「顺手编的外壳版本」当门槛

`make-patch.mjs` 原来写的是 `minShellVersion: shellVersion` —— 把「这次一起编出来的
外壳版本」当成了门槛。0.2.6 那次只有一笔动了 Rust（给原生菜单加「外观 → 皮肤…」），
外壳因此从 0.2.2 进到 0.2.3，补丁就自动声明「需要 0.2.3 或更新」，于是**所有装着
0.2.2 外壳的用户全被挡在补丁外面** —— 为了换一个 11 MB 的 exe，得下 318 MB 的完整包。

而他们根本不需要那个新外壳：前端读 `window.__TAURI__` 用的是可选链，老外壳上只是不
注册那个监听；皮肤对话框在顶栏「⋯」里还有一个入口，功能一点不缺。这就是标准的第二行，
却被当成了第三行。

教训有两条，都别再犯：

1. **「改了 Rust」不等于「必须完整安装包」。** 先问缺了会不会出事。
2. **门槛要自己声明，不能让它跟着构建产物走。** 跟着走的话，外壳每动一次就误伤一批用户。

### 已知缺口：没有「只换 exe」这一档

现在只有两档：补丁（Node 那半边，几 MB）和完整安装包（318 MB）。中间缺一档
**只换 `promptcut.exe`（11 MB）** 的外壳更新。

所以真碰上第三行那种硬依赖时，哪怕改的只是 Rust 里一行，用户也得把 Chrome、ffmpeg、
内置 Python 这些一点没变的东西重下一遍。上面那次靠「能降级」绕过去了，下次未必有这个运气。
要补这一档，得让 `make-patch` 能出一个只含 exe 的包，并且 `apply-patch` 认识这种包
（换 exe 之后 ProductVersion 会变，代次校验那套逻辑可以直接复用）。

**依赖变化**由 `package-lock.json` 的哈希自动判断：和上一次发布一致就不打包
`node_modules`（补丁几 MB），不一致就整个带上（本例 48 MB，仍远小于完整包）。
判断基准是 `release/manifest-<版本>.json`，每次发布自动留下一份 —— **别删它**，
删了下一次就只能保守地把依赖整个带上。

其他用法：

```powershell
npm run release -- --patch-only     # 只出补丁，跳过 Rust 编译
npm run release -- --skip-runtime   # runtime 已就绪，直接编译打包
npm run release -- --with-deps      # 强制把 node_modules 打进补丁
npm run make-patch                  # 只跑打补丁这一步
```

在自己机器上验证补丁而不真的写入：

```powershell
release\PromptCut-patch-0.2.3.exe -WhatIf
```

### 拓展库包

镜头识别、主体检测、运动追踪、语音识别要额外的 Python 依赖和模型。默认是运行时
`pip install` 现下载，断网、内网或者国内网络不通就装不上，而且每台机器都要重下一遍。
拓展库包把 wheel 和模型预先打好，**安装过程全程离线**（`pip --no-index`，明确禁掉 PyPI）。

**发给用户的是两档**，不是四个包——用户不该去弄懂里面有几个模型：

| 档 | 带来什么能力 | 里面有什么 | 实测体积 |
| --- | --- | --- | --- |
| **轻装档 `light`** | 镜头识别、主体检测（人脸 + 人体） | onnxruntime + transnetv2 / yunet / rtdetr_r18vd | wheel 实测 5 个 26.0 MB；模型 107 MB（29.6 + 0.2 + 77.3）；**exe 实测 124.0 MB**（130,038,628 字节） |
| **完整档 `full`** | 轻装档全部 + 运动追踪 + 开放词汇主体检测 | 再加 torch / transformers + bootstapir_v2.pt + grounding-dino-tiny/ | wheel 实测 34 个 177.4 MB；模型再多 208.7 + 658.3 MB；**exe 实测 1074.6 MB**（1,126,797,614 字节） |

（2026-09-07 修完许可证后重打的实测值。比上一版各大约 6.6 KB，多出来的就是包内
`THIRD-PARTY-LICENSES.txt` 里新加的三份许可证正文：light 17,696 字节 / full 18,605 字节。）

```powershell
npm run make-extension -- light --transnet <transnetv2.onnx> --yunet <yunet.onnx> --rtdetr <rtdetr_r18vd.onnx>
npm run make-extension -- full  --transnet … --yunet … --rtdetr … `
                                --bootstapir <bootstapir_v2.pt> --dino <grounding-dino-tiny 目录>
```

产物分目录落在 `release/extensions/_light/` 和 `_full/`：两个 exe 的名字只差一个词，
平铺在一起很容易发错文件给用户。

语音识别**不在这两档里**：它的模型是按需下载的（用户挑 small 还是 large-v3），
随包发没有意义，所以仍旧单独出 `stt` 包，只装依赖。

模型怎么来：`transnetv2.onnx` 见 [`tools/transnetv2/README.md`](../tools/transnetv2/README.md)，
其余四个见 [`tools/subject/README.md`](../tools/subject/README.md)。

老的按能力拆开的单项包**继续能用**，给开发者单独重打某一项：

```powershell
npm run make-extension -- shots --model <transnetv2.onnx 的路径>
npm run make-extension -- track --model <bootstapir_v2.pt 的路径>
npm run make-extension -- stt
```

几个要点：

- **wheel 用自带解释器 `pip download`**，不是开发机的 Python。wheel 的 ABI 标签
  （`cp311`）必须和用户机器上那个解释器对得上，否则装上去 import 不了。
- **拓展只带依赖和模型，用到它们的代码在应用里**。所以每个拓展声明 `requiresApp`，
  安装器读 `runtime/VERSIONS.json` 比对，版本太旧**在动手之前**就拒绝——不然用户
  白等一分钟，盘上还多出一堆没人用的 wheel。
- **模型落在 `%APPDATA%\com.promptcut.desktop\models`**，不在安装目录里，卸载软件
  不会把它删掉。依赖落在 `<安装目录>\runtime\pylibs`。模型条目**可以是目录**
  （`grounding-dino-tiny/` 那种 HF snapshot），安装器递归拷；同名目录先删再拷，
  免得升级时旧文件留在里面。
- 装完会**按 manifest 里的 `provides` 逐个能力自检**（light 档要 `promptcut_shots`
  和 `promptcut_subject` 都说自己能跑），有一个不过就算失败：文件到位但代码不认，
  和没装是一回事。各模块的就绪判据不一样——shots/track 看 `"ready": true`，
  subject 看 `"engine"` 不为 null（它分 light/full 两档），stt 看引擎 `installed`。
- **每个随包权重都必须写齐 `title` / `license` / `source`**，缺一项 `make-extension`
  直接拒绝出包（`assertModelMeta`），并要同步到
  [`THIRD-PARTY-LICENSES.md`](THIRD-PARTY-LICENSES.md) 第 9 节。`license` 还必须是
  `scripts/licenses/` 下有全文的 SPDX 标识符——写成 `Apache 2.0`（少个连字符）
  一样出不了包，因为那样就没有全文可附。
- **许可证全文随包走**。包里的 `THIRD-PARTY-LICENSES.txt` = 逐模型清单 + MIT /
  Apache-2.0 / BSD-3-Clause 三份**正文**（每份抬头写清适用于哪几个模型、原始版权行），
  装的时候 `apply-extension.ps1` 把它按包名拷到
  `%APPDATA%\com.promptcut.desktop\models\THIRD-PARTY-LICENSES-<包名>.txt`，和权重放一起
  （light / full 各一份、互不覆盖）。
  只发一张写着许可证名字的清单不满足 MIT／Apache-2.0 §4(a)／BSD-3 第 2 条 ——
  2026-09-07 之前的包就是那样，已作废重打。三份全文的来源见
  [`scripts/licenses/README.md`](scripts/licenses/README.md)。
- **wheel 的许可证用脚本扫，不靠人翻**：每次重打完跑
  `node scripts/scan-wheel-licenses.mjs`（读 `release/extensions/` 下的 manifest，
  逐个查 PyPI 的 `license_expression` + `classifiers`），命中 GPL / AGPL / LGPL /
  SSPL / 非商用 就退出码 1。2026-09-07 实测 light + full 合计 34 个包、0 个可疑。

拓展有自己的版本号，和应用版本、外壳版本三者独立。

打包脚本的纯逻辑（拓展表、许可证硬闸、manifest 生成）有单测，改完跑一下：

```powershell
node --test desktop/test/make-extension.test.mjs
```

## 外壳在 SKILL 模式里做的三件事（0.2.10 新增）

SKILL 模式是「把当前项目交给桌面版的 Claude Code / Codex 去改」。整条链路的主体在 Node
那半（`server/vite-plugin-skill*.ts`、`server/mcp-server.mjs`），外壳只负责三件**只有原生
一侧做得到**的事。三件全都能降级 —— 老外壳上不报错，只是少一个便利，所以这次外壳只进末位。

1. **`.proc` 文件关联**（`tauri.conf.json` 的 `bundle.fileAssociations`）
   双击 `.proc` 用 PromptCut 打开。启动参数交给 `/api/skill/open-path`，那边**先把文件复制
   到 `.pc-work/opened/` 再读副本** —— 原文件不被占用，双击一份别人正在编辑的 `.proc`
   不会互相踩。老外壳上没有这个关联，用户从软件里「打开」即可。

2. **`.proc` 的内核级独占锁**（`src/proc_lock.rs`，三个 Tauri 命令）
   两个 PromptCut 同时开着同一份 `.proc`，各自按内存里的状态往回写，后写的把先写的整份
   盖掉。锁分两层：Node 那半原子创建 `<name>.proc.lock` 并用 pid 兜底，外壳这半用 Windows
   共享模式 0 把那个锁文件的句柄独占住 —— **进程被强杀内核立刻收走**，不会留下解不开的
   死锁。顺序是先 Node 后外壳。前端调用处 `src/editor/io/procLock.ts` 全程可选链，
   浏览器里跑就只有 Node 那一层，够用，只是少了「被强杀也能自动解锁」。

3. **编辑界面收起、转入后台运行**（见下文「后台运行」）
   进 SKILL 模式时编辑界面缺省收起，桌面 APP 里的 Agent 经 MCP 直接改用户这份项目
   （A4，`server/mcp-server.mjs`），页面必须一直活着。老外壳上主窗照常留着，功能不缺。

## 菜单栏到导航栏的颜色过渡

原生菜单栏（文件 / 工具 / 外观 / 帮助）由 Windows 画、颜色跟系统主题走，网页里的导航栏是自己的深色，
贴在一起是一道生硬的分界。壳命令 `menu_bar_color`（`src-tauri/src/chrome_color.rs`）**直接采样屏幕上
菜单栏那一行的像素**（客户区上边往上几像素、靠右边没有文字的位置，三点取中位），不查系统颜色 ——
暗色模式下 `GetSysColor(COLOR_MENUBAR)` 给的还是亮色值。前端 `src/ui/MenuBarFade.tsx` 拿到颜色后写进
`--pc-menubar`，在编辑器和开始页顶部铺 10px 的渐变（`.pc-bar-fade`）过渡到导航栏底色；
窗口重新拿到焦点、页面重新可见时再采一次，系统换主题也跟得上。浏览器里跑时没有壳，这条高度为 0。

## 后台运行：托盘图标、悬浮窗、关窗不退出（A5）

语义见 `docs/semantics/user-workflow.md`「后台运行」：关闭编辑界面不退出，软件转为托盘图标和悬浮窗
继续运行；点托盘图标或悬浮窗重新打开编辑界面；只有在托盘图标或悬浮窗上右键选「关闭」才退出。
代码在 `src-tauri/src/background.rs`（状态机、托盘、收起与挪回）和 `src-tauri/src/skill_shell.rs`（悬浮窗）。

| 操作 | 结果 |
|---|---|
| 点主窗的 ×（或 Alt+F4） | 编辑界面收起，出悬浮窗，托盘图标照常在 |
| 进 SKILL 模式（状态文件变成 `active: true`） | 编辑界面收起；之后用户自己打开的不会再被收回 |
| 回到传统式（`active: false`），此时编辑界面收着 | 编辑界面打开 |
| 托盘左键单击 / 单击悬浮窗 / 菜单「打开编辑界面」/ 再启动一次 | 编辑界面打开并拿到焦点 |
| 托盘右键或悬浮窗右键 →「关闭」（标题栏菜单「退出」、`promptcut.exe --quit` 同路） | 真退出：sidecar 整棵树清掉、`.proc` 锁释放（`RunEvent` 里做，和原来一样） |

**`--quit`**：再启动一次带这个参数，已在跑的那一份干净退出（更新补丁 `scripts/apply-patch.ps1` 关软件时先用它，10 秒没退再关窗口 + 强杀）；没有实例在跑时带 `--quit` 直接退出，不起新的。

**收起不是 `hide()`。** WebView2 被 `hide()` 后会停渲染，页面侧的 Agent 工具（`side: "page"`）、悬浮窗的
「上一步动作」预览都跟着停。所以主窗留着「可见」，只是挪到所有显示器最左边再往左一个窗宽加 256 像素
（`offscreen_position`，不用 -32000：那是 Windows 给最小化窗口的坐标）、不进任务栏、不抢焦点；挪回来
时回到记下的位置（显示器没了就居中），收起前是最大化的再最大化。WebView2 的启动参数
（`agent_webview::browser_args`，主窗、agent 子 webview、悬浮窗三处共用）另外关掉了 Chromium 的遮挡判断
（`CalculateNativeWinOcclusion`）和后台降频，防的是屏幕外的窗口被当成「被挡住」而降频。

**主窗口要按 `get_window("main")` 查。** 主窗口里加了 agent 的子 webview 之后它就不再是
`WebviewWindow`，`get_webview_window("main")` 返回 None —— 以前 SKILL 收起用的 `main.hide()`、
第二次启动时的「叫回窗口」就是这样悄悄失效的。

**退出前把主窗挪回原位。** window-state 插件在退出时记窗口位置，收起状态下直接退会记下屏幕外的坐标。
所以退出路径先把主窗藏起来、挪回收起前的位置再退；插件也不再记「可见」这一位（`lib.rs`）。
收起前是最大化的，退出时只还原位置、不再最大化（藏着的窗口一最大化就会显示，而且退出那一刻来不及生效），
下次启动是普通窗口。

**悬浮窗**（`ui/overlay.html`、`ui/overlay-summary.js`）：编辑界面收起时出现，第一次收起时才建，
之后只显示 / 隐藏；右上角，可拖（按下后挪超过 4 像素才算拖，交给外壳 `startDragging`），单击打开
编辑界面，右键弹外壳的原生菜单。页面加载完发 `pc-overlay-ready`，外壳把手上的状态重推一遍。

- 非 SKILL：写「PromptCut 在后台运行」。
- SKILL：外壳每秒取一次编辑器进程的 `GET /api/agent/desktop`（A4 的桌面会话分组，只挑厂商、正在做的、
  上一步几个字段），悬浮窗写「Claude Code 正在改卡片」「Codex 上一步：读项目」之类；编辑器连不上时写明。
- SKILL 下「上一步动作」的画面：用户这份页面渲好交回 `/api/skill-mode/last-action`，写到
  `~/Documents/PromptCut-Skill/last-action.{png,json}`；外壳盯 json 的修改时间，变了就读成 data URL 推给
  悬浮页（`pc-skill-preview`），第一张到的时候把悬浮窗撑高（卡片 72 + 间距 8 + 预览块 152）。

事件：悬浮页 → 外壳 `pc-overlay-open`（单击）、`pc-overlay-menu`（右键）、`pc-overlay-ready`；
外壳 → 悬浮页 `pc-overlay-state`、`pc-skill-preview`。两头的名字由 `desktop/test/overlay-summary.test.mjs` 对着。

纯逻辑的单测：状态机、屏幕外坐标、菜单项、HTTP 回应拆包、状态文件解析在 `cargo test --lib`；
悬浮窗文字在 `node --test desktop/test/overlay-summary.test.mjs`。

## Agent 的浏览器:主窗口里的子 webview

Agent 上网（`web_*` 工具、B 站账号密码登录）用的浏览器**不再是独立的 Chrome 窗口**，而是
Tauri 主窗口里的一块子 webview（`src-tauri/src/agent_webview.rs`，需要 tauri 的 `unstable`
特性）。壳启动时给 WebView2 开 `--remote-debugging-port`（随机空闲端口，通过环境变量
`PROMPTCUT_AGENT_CDP` 交给 sidecar），Node 那边的 puppeteer 直接连上来驱动它，代码和
Chrome 方案共用（`server/web/browser.mjs` 的 `connectShell`）。

- **平时藏在客户区外面**（x = -4000），不是 `hide()`：藏了 WebView2 就停止渲染，agent 截图会是空白。
- **默认静音**（`ICoreWebView2_8::IsMuted`）。只有用户在浏览器面板上点喇叭才放开，回到编辑时再静掉。
- **不弹窗打断**：agent 调 `web_handoff` 时顶栏的「浏览器」页签闪烁并冒「有待操作事务」的气泡，
  用户点页签才切到面板（`src/editor/AgentBrowserTab.tsx`、`src/editor/right/AgentBrowserFrame.tsx`），
  面板把 webview 摆到编辑区上，「回到编辑」挪回去。
- 壳里每次导航都注入 `window.__PROMPTCUT_AGENT__ = true`，sidecar 热重启后按它重新认出这一块。
- 四条壳命令：`agent_webview_show / hide / mute / info`。**应用自定义命令在 Tauri 2 里默认不放行**：
  `build.rs` 登记命令名生成 `permissions/autogenerated/`，`capabilities/default.json`（本地来源）和
  `capabilities/remote.json`（sidecar 的 `http://127.0.0.1:5210`）都要引用 `allow-<命令>`。
  以前的 `acquire_proc_lock` 三个命令就是因为没登记一直静默失败，这次一并补上。
- 调试端口只绑 127.0.0.1，本机任何进程都能连上操控这块 webview；本机进程本来就以当前用户身份运行，
  不算新的越权面，但得知道有这回事。

浏览器里跑 `npm run dev`（没有壳）时一切退回原来的 Chrome for Testing 方案（离屏窗口、`--mute-audio`）。

## 开发期

开发时不需要每次都跑 `prepare-runtime`。先跑一次组装好 `src-tauri/runtime/`，然后：

```powershell
# 设置环境变量，让壳直接使用已组装好的 runtime，免得每次复制
$env:PROMPTCUT_RUNTIME_DIR = "$PWD\src-tauri\runtime"

# 启动 Tauri 开发模式（Rust 热重载 + 前端 live reload）
npm run dev
```

也可以单独跑 PromptCut 的 dev server（在项目根目录 `npm run dev`），壳会检测到 5210 端口已有实例并直接连上去。

这种「壳连仓库里的 dev server」的跑法要测 agent 浏览器（壳内子 webview）时，dev server 拿不到壳随机挑的
调试端口，两边设同一个 `PROMPTCUT_AGENT_CDP` 就能对上：

```powershell
$env:PROMPTCUT_AGENT_CDP = "9333"
node node_modules/vite/bin/vite.js --port 5210 --strictPort --host 127.0.0.1   # 项目根目录
# 另一个终端,同样设 PROMPTCUT_AGENT_CDP 和 PROMPTCUT_RUNTIME_DIR 后启动 src-tauri\target\debug\promptcut.exe
```

起来后 `http://127.0.0.1:9333/json/list` 能看到两个 target：`about:blank#promptcut-agent`（agent 那块）和编辑台主页面。

## 验收（冒烟测试）

```powershell
# 需要先构建出可执行文件（cargo build --release 或 npm run build）
npm run smoke
```

`smoke` 会依次执行：

1. **smoke-boot**：启动 exe → 等进程出现 → 等窗口标题含 `PromptCut` → `GET http://127.0.0.1:5210/` 返回 200 → 检查 `/api/stt/status`（记录结果，不作为通过条件）→ 确认后代进程树含 `node.exe`
2. **smoke-shutdown**：`taskkill /F /T` 杀主进程 → 等 5 秒 → 确认进程树全部消失

> **注意**：导出冒烟（smoke-export）本轮未实现，`ALL_RESULT_JSON` 中标记为 `"export": "not-implemented"`。

## 给最终用户

### 安装

- 安装包未签名，首次运行会弹 Windows SmartScreen 提示。点击「更多信息」→「仍要运行」即可。
- 安装到 `%LOCALAPPDATA%\PromptCut`（当前用户），不需要管理员权限。

### 使用

- 点窗口的关闭按钮不会退出，软件收到托盘和右上角的悬浮窗里继续运行（Agent 照常干活）；
  点托盘图标或悬浮窗打开，右键托盘图标或悬浮窗选「关闭」才真退出。
- 导出的视频成品保存在 `%USERPROFILE%\Videos\PromptCut`。
- 语音识别的引擎和模型在首次使用时在线下载，保存在 `%APPDATA%\com.promptcut.desktop`。

### 端口 5210 被占

如果启动时弹「端口被占用」对话框：

```powershell
# 查看谁占了 5210
netstat -ano | findstr :5210
# 根据 PID 找到进程
tasklist /FI "PID eq <PID>"
```

关掉占用端口的程序后重新启动 PromptCut。

### 查看日志

菜单 → 帮助 → 查看运行日志。日志文件在 `%APPDATA%\com.promptcut.desktop\logs\sidecar.log`。

## 目录结构

```
desktop/
  package.json
  README.md
  THIRD-PARTY-LICENSES.md
  .gitignore
  ui/index.html                   启动等待页
  ui/overlay.html                 编辑界面收起后右上角的悬浮窗(单击打开、右键菜单、SKILL 进度与预览)
  ui/overlay-summary.js           悬浮窗上那两行字怎么写(node 单测直接跑这份)
  scripts/
    prepare-runtime.mjs           组装 runtime/
    prepare-python.mjs            组装内置 Python（由 python-runtime 任务提供）
    build-release.mjs             出一个版本：安装包 + 更新补丁
    make-patch.mjs                只打更新补丁
    apply-patch.ps1               补丁安装器（随补丁包发给用户，不在这里运行）
    apply-patch.cmd               补丁包里的「安装更新.cmd」
    patch-installer.nsi           补丁 exe 的自解压外壳(NSIS,须带 UTF-8 BOM)
    make-extension.mjs            打拓展库包(离线依赖 + 模型)
    licenses/                     MIT / Apache-2.0 / BSD-3-Clause 三份全文,
                                  打包时追加到包内 THIRD-PARTY-LICENSES.txt 末尾
                                  (文件名就是 SPDX 标识符,MODEL_META 的 license 要能对上)
    scan-wheel-licenses.mjs       扫拓展包各 wheel 的许可证(查 PyPI,命中 GPL 类就退 1)
    apply-extension.ps1           拓展包安装器(随包发给用户)
    extension-installer.nsi       拓展 exe 的自解压外壳(同样须带 BOM)
    smoke-procs.mjs               进程树工具（共用）
    smoke-boot.mjs                启动冒烟
    smoke-shutdown.mjs            关闭冒烟
    smoke-all.mjs                 全流程冒烟
  test/
    make-extension.test.mjs       拓展表/许可证硬闸/manifest 的单测(node --test)
    overlay-summary.test.mjs      悬浮窗文字、与外壳的事件名对照
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/default.json
    nsis/hooks.nsh
    src/main.rs
    src/lib.rs
    src/proc_lock.rs              .proc 的内核级独占锁(Windows 共享模式 0;进程一死内核就收)
    src/background.rs             后台运行:打开/收起/退出的状态机、托盘、主窗挪到屏幕外与挪回
    src/skill_shell.rs            悬浮窗;盯 SKILL 状态文件(变成 SKILL 时收起编辑界面)、推进度与预览
    icons/icon-source.svg         图标源文件
    binaries/                     (git ignored) node sidecar
    runtime/                      (git ignored) 运行时组件
      app/                        PromptCut 源码副本 + node_modules + dist
      chrome/                     Chrome for Testing
      ffmpeg/                     ffmpeg.exe + ffprobe.exe
      python/                     内置 Python
      VERSIONS.json               各组件版本
  release/                        (git ignored) 发布产物
    PromptCut-<版本>-setup.exe    完整安装包
    PromptCut-patch-<版本>.exe    更新补丁(双击即装)
    manifest-<版本>.json          该版本的文件清单，下一次发布拿它算差异
    extensions/                   拓展库包单独放这里 —— 它们按自己的节奏出版本，
      _light/                     和安装包/补丁不是一批东西，混在一起时
        PromptCut-ext-light-<版本>.exe   一眼看不出这次发布该给用户哪几个文件。
        ext-light-<版本>.json            两档再各占一个子目录：两个 exe 名字只
        THIRD-PARTY-LICENSES.txt         差一个词，平铺着很容易发错。
      _full/
        PromptCut-ext-full-<版本>.exe
        ext-full-<版本>.json
        THIRD-PARTY-LICENSES.txt
      PromptCut-ext-<单项名>-<版本>.exe  单项包（shots/track/stt）还是平铺在这里
```

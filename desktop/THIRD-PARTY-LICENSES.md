# PromptCut Desktop — 第三方许可证

本文档列出 PromptCut Desktop 安装包中包含或可能包含的第三方软件及其许可证。**分发前请逐项核实**。

---

## 1. Node.js

- **用途**：Sidecar 进程，运行 Vite dev server 提供编辑器后端接口
- **许可证**：MIT License
- **来源**：https://nodejs.org/
- **版权**：Copyright Node.js contributors
- **说明**：安装包中包含完整的 `node.exe` 二进制文件（从构建机的 Node 安装中复制）

## 2. Chrome for Testing

- **用途**：Puppeteer 驱动的导出渲染引擎（虚拟时间逐帧截图）
- **许可证**：Google Chrome for Testing 遵循 Chromium 的 BSD 3-Clause License；包含的各组件有各自的许可证
- **来源**：https://googlechromelabs.github.io/chrome-for-testing/
- **说明**：安装包中包含完整的 Chrome for Testing 二进制文件（约 300 MB）。不包含 chrome-headless-shell。
- **未核实，分发前请确认**：Chrome for Testing 的具体再分发条款是否允许以安装包形式捆绑分发

## 3. FFmpeg

- **用途**：音视频编解码（导出帧合成、音频转 WAV 供语音识别使用）
- **许可证**：**GNU General Public License v3 (GPLv3)**
- **来源**：https://www.gyan.dev/ffmpeg/builds/ （Gyan 的 full build）
- **版权**：Copyright FFmpeg developers
- **重要提示**：Gyan 的 full build 是 **GPL** 构建（启用了 GPL 授权的编解码器），不是 LGPL。以安装包形式分发 GPL 二进制文件，需要满足以下义务：
  1. 随安装包附带 GPL v3 全文（`runtime/ffmpeg/LICENSE` 文件）
  2. 提供对应版本 ffmpeg 源码的获取途径（书面要约或下载链接）
  3. 如果 PromptCut 自身的代码通过进程间通信方式调用 ffmpeg（`spawn('ffmpeg', …)`），一般被视为"聚合"(mere aggregation)而非衍生作品，PromptCut 自身代码不需要 GPL 授权。但 **未核实，分发前请咨询法律意见确认**。
- **安装包内 LICENSE 文件**：`prepare-runtime.mjs` 会从 ffmpeg 安装目录复制 `LICENSE` 和 `README` 到 `runtime/ffmpeg/`

<details>
<summary>GPL v3 全文获取</summary>

完整的 GNU General Public License v3 全文可在以下地址获取：
https://www.gnu.org/licenses/gpl-3.0.txt

对应版本的 ffmpeg 源码可从以下地址获取：
https://www.gyan.dev/ffmpeg/builds/#release-builds （选择对应版本的 source 链接）
或 https://git.ffmpeg.org/ffmpeg.git

</details>

## 4. Tauri 及 Rust 依赖

- **用途**：桌面壳框架，提供窗口、菜单、系统集成
- **许可证**：MIT License 或 Apache-2.0（双许可）
- **来源**：https://tauri.app/
- **包含的 Tauri 插件**：
  - `tauri-plugin-shell`：MIT/Apache-2.0
  - `tauri-plugin-single-instance`：MIT/Apache-2.0
  - `tauri-plugin-opener`：MIT/Apache-2.0
  - `tauri-plugin-window-state`：MIT/Apache-2.0
- **其他 Rust 依赖**：
  - `rfd` (Rusty File Dialogs)：MIT License
  - `serde` / `serde_json`：MIT License 或 Apache-2.0
- **说明**：这些依赖在 Rust 编译时静态链接进 `promptcut.exe`。完整的依赖树可通过 `cargo tree` 查看。

### 完整依赖树的核查结果

闸门配置在 `desktop/src-tauri/deny.toml`，跑法：

```powershell
cd desktop/src-tauri
cargo deny check licenses     # 2026-09-08：licenses ok
```

`deny.toml` 的 `allow` 是白名单，**引进新许可证会当场失败**，不会悄悄混进去。
2026-09-08 全量核过一遍（Tauri 2.11 依赖树，约 460 个 crate）：

| 许可证 | 个数 | 处理 |
| --- | --- | --- |
| MIT / Apache-2.0（多数为双许可） | 绝大部分 | 保留声明即可 |
| Unicode-3.0 | 19（ICU 系） | 保留声明 |
| Zlib / Unlicense / 0BSD / CC0-1.0 / MIT-0 / ISC / BSD-2 / BSD-3 | 若干 | 保留声明 |
| **MPL-2.0** | 5：`cssparser`、`cssparser-macros`、`dtoa-short`、`selectors`、`option-ext` | 见下面的源码获取说明 |
| LGPL-2.1-or-later | 名义上 1：`r-efi` | 它是 `MIT OR Apache-2.0 OR LGPL-2.1-or-later` 三选一，**我们取 MIT**（`deny.toml` 里 clarify 明确了）；而且它是 wasi 目标的依赖，Windows 包里不参与编译 |

**没有 GPL / AGPL / SSPL。**

#### MPL-2.0 的源码获取（§3.2 义务）

上面 5 个 crate 是弱著佐权、**按文件计**：允许静态链进闭源二进制，但必须让拿到二进制的人
能取得**这些文件本身**的源码。它们全部是 crates.io 上的公开发布版本，源码按下面的地址取，
版本号见 `desktop/src-tauri/Cargo.lock`：

- `cssparser` / `cssparser-macros` / `selectors`：https://github.com/servo/rust-cssparser 、
  https://github.com/servo/stylo
- `dtoa-short`：https://github.com/upsuper/dtoa-short
- `option-ext`：https://github.com/soc/option-ext

我们没有修改过其中任何一个文件。

## 5. WebView2

- **用途**：渲染编辑器界面的浏览器引擎
- **许可证**：Microsoft Edge WebView2 Runtime 许可条款
- **来源**：https://developer.microsoft.com/en-us/microsoft-edge/webview2/
- **说明**：WebView2 Runtime 不随安装包分发。Windows 10/11 通常已预装。若缺失，安装包的 downloadBootstrapper 模式会引导用户在线下载。
- **未核实，分发前请确认**：WebView2 SDK 的再分发条款

## 6. PromptCut npm 依赖

安装包中 `runtime/app/node_modules/` 包含 PromptCut 项目的全部 npm 依赖。主要许可证：

| 包                      | 许可证        | 说明                               |
| ----------------------- | ------------- | ---------------------------------- |
| `react` / `react-dom`   | MIT           | UI 框架                            |
| `motion`                | MIT           | 动画库                             |
| `vite`                  | MIT           | 开发服务器及构建工具                |
| `@vitejs/plugin-react`  | MIT           | Vite 的 React 支持插件             |
| `tailwindcss`           | MIT           | CSS 框架                           |
| `puppeteer`             | Apache-2.0    | Chrome 自动化（导出用）            |
| `pngjs`                 | MIT           | PNG 编解码（确定性验证用）         |
| `lottie-web`            | MIT           | Lottie 动画播放（Lottie 卡）；素材文件另有各自许可 |
| `@tsparticles/engine` / `@tsparticles/slim` | MIT | canvas 粒子（粒子背景卡）  |
| `typescript`            | Apache-2.0    | TypeScript 编译器（开发依赖）      |
| `react-markdown`        | MIT           | AI 回复的 Markdown 渲染            |
| `remark-gfm`            | MIT           | Markdown 的表格 / 任务列表扩展     |
| `remark-math` / `rehype-katex` | MIT    | Markdown 里的公式                  |
| `katex`                 | MIT           | 公式排版（含自带字体，同为 MIT）   |
| `node-pty`              | MIT           | 伪终端（CLI 驱动跑 claude / codex）|

### 完整依赖树的核查结果

`npx license-checker --summary`（0.2.10 版，241 个包）：

| 许可证 | 个数 | 处理 |
| --- | --- | --- |
| MIT | 217 | 随包分发源码即满足署名要求 |
| ISC | 8 | 同上 |
| Apache-2.0 | 7 | `puppeteer` / `puppeteer-core` / `@puppeteer/browsers` / `chromium-bidi` / `webdriver-bidi-protocol` / `typescript` / `detect-libc`。需保留 NOTICE 与许可证正文，node_modules 原样分发即满足 |
| **MPL-2.0** | 4 | `lightningcss` 及其 win32-x64 二进制（`tailwindcss` v4 的依赖）。**弱著佐权，按文件计**：只要原样分发、不修改其源码、并保证用户能拿到这些文件的源码即可。我们把整个 `node_modules` 原样打进 `runtime/app`，源码就在包里，满足 §3.2 |
| BSD-3-Clause | 2 | `devtools-protocol`、`source-map-js` |
| BSD-2-Clause | 1 | `entities` |
| 0BSD | 1 | `tslib` |
| UNLICENSED | 1 | PromptCut 自己（`package.json` 里 private），不是第三方 |

**没有 GPL / AGPL / SSPL 类强著佐权依赖。** 换依赖之后重跑一次
`npx license-checker --summary`，数字对不上就按上表补登记。

## 7. 内置 Python（随安装包分发）

- **用途**：语音转文字、镜头识别、运动追踪的运行环境
- **许可证**：PSF License (Python Software Foundation License)
- **来源**：https://www.python.org/downloads/windows/ （Windows embeddable package 3.11.9）
- **说明**：内置 Python 解释器随安装包分发。PSF License 允许再分发。
- **未核实，分发前请确认**：具体使用的 Python 版本的 PSF License 条款

### 7.1 内置 Python 里预装的第三方库（随安装包分发）

这些库**装在解释器的 site-packages 里、随安装包一起发出去**，和第 8 节
「用户自行下载」的性质完全不同 —— 它们的许可证义务在我们这边。

| 库          | 版本   | 许可证       | 用途                                     |
| ----------- | ------ | ------------ | ---------------------------------------- |
| `numpy`     | 2.2.6  | BSD-3-Clause | 运动追踪未装拓展时的模板匹配兜底档所需     |
| `pip`       | 26.2.1 | MIT          | 安装拓展依赖                             |
| `setuptools`| 84.0.0 | MIT          | pip 的依赖                               |
| `wheel`     | 0.48.0 | MIT          | pip 的依赖                               |

**加库到基础运行时要同步改这一节**（改的是 `desktop/scripts/prepare-python.mjs`
里的 `BASE_LIBS`）。基础运行时里的东西不像拓展包那样是用户主动下载的，
漏登记就是我们自己在无证分发。

### 7.2 移植自第三方的源码（随安装包分发）

上面 7.1 是**整包照搬**的第三方库；这一节是我们自己写、但**算法或代码移植自第三方**
的文件。它们混在 `promptcut_*` 包里，看上去像自研代码，最容易漏登记 ——
`prepare-python.mjs` 的 `copyDir` 会把 `python/` 下所有 `promptcut_*` 包整包复制进
`runtime/python/Lib/site-packages`（只跳过 `__pycache__` 和 `.pyc`），所以这些文件
**连同同目录的 LICENSE-\* 一起**随主安装包进用户机器。

| 文件 | 移植自 | 许可证 | 随包的全文 |
| --- | --- | --- | --- |
| `python/promptcut_subject/yunet.py` | OpenCV `FaceDetectorYN`（`modules/objdetect/src/face_detect.cpp`），https://github.com/opencv/opencv | Apache-2.0 | `python/promptcut_subject/LICENSE-opencv` |
| `python/promptcut_track/vendor/tapnet_torch/` | google-deepmind/tapnet 的 PyTorch 推理代码 | Apache-2.0 | 该目录下的 `LICENSE` |

- **OpenCV FaceDetectorYN → `yunet.py`**：不是逐行照抄源码，但前后处理的算法和常量
  （先验框解码公式、stride 8/16/32 三组输出按 `r*cols+c` 展平的顺序、
  `score = sqrt(cls*obj)`）都来自那份 C++ 实现，按 Apache-2.0 §1 属于衍生作品。
  **改动**（§4(b) 要求注明）：用 numpy 重写、**不依赖 cv2**、letterbox 自己实现、
  分数阈值由 OpenCV 默认的 0.9 改为 0.6（NMS 阈值 0.3 与上游相同）、输出改成 Python dict。
  **署名**：OpenCV 仓库根目录的 `LICENSE` 就是 Apache-2.0 全文本身、**没有任何版权行**
  （2026-09-07 实测 202 行，与 https://www.apache.org/licenses/LICENSE-2.0.txt 逐字相同），
  `face_detect.cpp` 的文件头也只写「subject to the license terms in the LICENSE file」，
  仓库里没有 `NOTICE` 文件（raw 取回 404）—— 上游没有可保留的版权声明，这里不编一个。
  §4(a) 要求的许可证全文放在 `python/promptcut_subject/LICENSE-opencv`，
  `yunet.py` 文件头也写了这段声明。

- **tapnet PyTorch 推理代码 → `promptcut_track/vendor/tapnet_torch/`**：见第 9 节
  BootsTAPIR 那条，只改了包内 import 路径，`LICENSE` 全文在该目录下。上游源码文件头的
  版权行是 `Copyright 2026 Google LLC`（仓库根 `LICENSE` 是未填写的 Apache-2.0 模板）。

**新增这类文件要同步改这一节**：判据是「这份代码的算法或结构来自某个第三方仓库」，
不是「有没有复制粘贴」。

> **发版前必须重跑 `npm run prepare-python`**。`copyDir` 确实会带上无扩展名的
> `LICENSE*` 文件（2026-09-07 实测：`runtime/python/Lib/site-packages/promptcut_track/vendor/tapnet_torch/LICENSE`
> 在组装好的运行时里），但它只在 `prepare-python` 跑的那一刻复制一次。当前
> `desktop/src-tauri/runtime/` 里只有 `promptcut_shots / stt / track`，**还没有
> `promptcut_subject`**（那份运行时是主体检测加进来之前组装的）—— 不重跑的话，
> 装出来的软件里既没有 `yunet.py` 也没有 `LICENSE-opencv`。

## 8. 用户自行下载的组件（不随安装包分发）

以下组件**不包含在安装包中**，由用户首次使用语音识别功能时在线下载到 `%APPDATA%\com.promptcut.desktop\`：

| 组件                     | 许可证              | 说明                              |
| ------------------------ | ------------------- | --------------------------------- |
| `faster-whisper`         | MIT                 | 语音识别引擎                      |
| `whisper` (OpenAI)       | MIT                 | 语音识别引擎（备选）              |
| `CTranslate2`            | MIT                 | faster-whisper 的推理后端         |
| `PyTorch`                | BSD-3-Clause        | 深度学习框架                      |
| Whisper 模型权重          | MIT (OpenAI)        | 语音识别模型                      |

由于这些组件由用户主动下载，不构成安装包的一部分，其许可证义务由用户自行承担。

## 9. 拓展库包内的模型权重（随拓展包分发）

拓展库包（`PromptCut-ext-<名字>-<版本>.exe`）是独立于安装包的可选下载，但它**确实
把模型权重分发给了用户**，所以每一份权重都要在这里列清楚。

`desktop/scripts/make-extension.mjs` 里每个模型必须写齐 `title` / `license` /
`source`，缺一项就打不出包——这是硬闸，不指望发布前有人记得回头补文档。`license`
还必须是 `desktop/scripts/licenses/` 下有全文的 SPDX 标识符，写成 `Apache 2.0`
（少个连字符）这种拼法同样出不了包。

**许可证全文随包分发**：打包时 `buildLicenseText` 把逐模型的清单
**加上 MIT / Apache-2.0 / BSD-3-Clause 三份全文**（每份抬头写清适用于哪几个模型、
各自的原始版权行）写成包内的 `THIRD-PARTY-LICENSES.txt`；`apply-extension.ps1`
装的时候把它拷到 `%APPDATA%\com.promptcut.desktop\models\THIRD-PARTY-LICENSES-<包名>.txt`（按包名落地，light / full 各一份互不覆盖——共用一个文件名的话装 light 会把 full 那份盖掉，bootstapir / grounding-dino 就没了记录），
和权重放在同一个目录。三份全文的来源和与 SPDX 官方文本的比对结果见
[`desktop/scripts/licenses/README.md`](scripts/licenses/README.md)。

> **2026-09-07 修正**：在此之前包里只有一张写着许可证**名字**的清单，没有任何一段
> 正文，而本文档却声称「全文已随包附带」；同时 YuNet 被标成了 Apache-2.0（实际 MIT）。
> 已打出的那两个 exe 是错的，必须重打——下面的表已是修正后的口径。

发给用户的是两档：**轻装档（light）** = 镜头识别 + 主体检测（只用 onnxruntime），
**完整档（full）** = 轻装档 + 运动追踪 + 开放词汇主体检测（带 PyTorch）。下表的
「档位」列写的是哪一档会分发这份权重。

| 模型 | 用途 | 档位 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| TransNet V2 (`transnetv2.onnx`) | 镜头切换识别 | light + full | MIT | https://github.com/soCzech/TransNetV2 |
| YuNet (`yunet.onnx`) | 主体检测（人脸） | light + full | **MIT**（权重训练上游另为 BSD-3-Clause） | https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet |
| RT-DETR-R18vd (`rtdetr_r18vd.onnx`) | 主体检测（人体/物体） | light + full | Apache-2.0 | https://huggingface.co/PekingU/rtdetr_r18vd |
| BootsTAPIR (`bootstapir_v2.pt`) | 运动追踪 | full | Apache-2.0 | https://github.com/google-deepmind/tapnet |
| Grounding DINO Tiny (`grounding-dino-tiny/`) | 主体检测（开放词汇） | full | Apache-2.0 | https://huggingface.co/IDEA-Research/grounding-dino-tiny |

- **TransNet V2**：`Copyright (c) 2020 Tomáš Souček`（上游 LICENSE 逐字如此；本文档
  原来还写了 Jakub Lokoč，他是论文作者，不在版权行里）。随包的 `.onnx` 由官方
  TensorFlow checkpoint 经官方 `convert_weights.py` 转 PyTorch 后导出，未再训练，
  生成步骤见 [`tools/transnetv2/README.md`](../tools/transnetv2/README.md)。MIT 要求
  保留版权声明和许可证全文，两者都在包内的 `THIRD-PARTY-LICENSES.txt` 里。

- **BootsTAPIR**：`Copyright 2026 Google LLC`（上游仓库根 `LICENSE` 是未填写的
  Apache-2.0 模板，版权行只出现在源码文件头，逐字如此）。官方 checkpoint 原样收录，未做
  转换或再训练；官方仓库明确说明 checkpoints 与代码同为 Apache 2.0。本模型的
  PyTorch 推理代码也一并收录在 `python/promptcut_track/vendor/tapnet_torch/`
  （同为 Apache 2.0，仅改了包内 import 路径，模型结构未动，LICENSE 全文在该目录下）。
  Apache 2.0 要求保留版权声明、许可证全文和改动说明，三者均已附带。
  **曾评估 CoTracker3 并否决**：其整个仓库为 CC-BY-NC，禁止商用，既不能随包分发，
  用户拿它做商业剪辑也违约——见下面的检查清单。

- **YuNet**：**许可证是 MIT，不是 Apache-2.0**。`Copyright (c) 2020 Shiqi Yu
  <shiqi.yu@gmail.com>`。opencv_zoo **根仓库**确实是 Apache-2.0，但它的 README 明写
  「Please refer to licenses of different models」，而
  [`models/face_detection_yunet/`](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)
  目录下自带一份 MIT `LICENSE`，以目录内的为准（2026-09-07 用 `curl` 取回逐字核对，
  正文与 https://spdx.org/licenses/MIT.txt 相同）。所以引用来源必须精确到**模型目录**，
  指到根仓库就会读成 Apache-2.0 —— 这正是之前标错的原因。
  权重的**训练上游**是另一个仓库 [ShiqiYu/libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train)，
  许可证为 **BSD-3-Clause**（`Copyright (c) 2022-2026, Shiqi Yu <shiqi.yu@gmail.com>`）。
  MIT 和 BSD-3-Clause 两份全文都在包内的 `THIRD-PARTY-LICENSES.txt` 末尾。
  随包的 `.onnx` 是 opencv_zoo 里的官方文件（`face_detection_yunet_2023mar.onnx`，
  0.22 MB / 232,589 字节）原样收录，未做转换或再训练，取得方式见
  [`tools/subject/README.md`](../tools/subject/README.md)。
  **需要自行评估的一点**：它训练用的 WIDER FACE 数据集条款是非商用。业界（OpenCV
  官方仓库在内）普遍按模型自身的许可证分发这份权重，我们也照此收录；对数据集条款
  是否穿透到权重存在不同意见，分发前请自行评估。

- **RT-DETR-R18vd**：**上游没有可保留的版权行，所以这里不写**。lyuwenyu/RT-DETR 的
  `LICENSE` 是未填写的 Apache-2.0 模板（结尾仍是 `Copyright [yyyy] [name of copyright owner]`
  占位符），HF 仓库 `PekingU/rtdetr_r18vd` 里没有 `LICENSE` 文件也没有版权声明；
  Apache-2.0 §4(c) 要求保留的是「Source form 里已有的」声明，这里没有可保留的，
  编一行反而是错的（本文档和 `MODEL_META` 之前都编了「Copyright (c) Peking University /
  lyuwenyu」，已删）。事实描述：模型由 lyuwenyu 等发布于
  https://github.com/lyuwenyu/RT-DETR ，HF 镜像 `PekingU/rtdetr_r18vd` 标注 apache-2.0
  （2026-09-07 查 HF API：`cardData.license = "apache-2.0"`）。随包的 `.onnx` 由该 HF
  权重经 `torch.onnx.export` 导出（opset 17，输入 `[1,3,640,640]`），**未再训练**，
  导出脚本见 [`tools/subject/README.md`](../tools/subject/README.md)。训练集为 COCO。

- **Grounding DINO Tiny**：`Copyright 2023 - present, IDEA Research.`（上游
  GroundingDINO 仓库 LICENSE 附录里填好的那一行，逐字如此）。随包的
  `grounding-dino-tiny/` 是 Hugging Face `IDEA-Research/grounding-dino-tiny` 的
  snapshot 原样收录（只取 `safetensors` 那份权重，不带重复的 `.bin`），未做转换或
  再训练。**注意版本**：IDEA 的 Grounding DINO 1.5 / 1.6 不开源，本包用的是开源的
  1.0（Apache-2.0）。Apache 2.0 要求保留版权声明和许可证全文，两者都在包内的
  `THIRD-PARTY-LICENSES.txt` 里。

拓展包里的 Python 依赖（`wheels/`）各自的许可证见各 wheel 内的 `METADATA` / `LICENSE`：

- **轻装档（light）**含 onnxruntime（MIT）、numpy（`BSD-3-Clause AND 0BSD AND MIT AND
  Zlib AND CC0-1.0`）、protobuf（BSD-3-Clause）、flatbuffers（Apache-2.0）、
  packaging（`Apache-2.0 OR BSD-2-Clause`）。实测 5 个 wheel，26 MB。
- **完整档（full）**在此之上还含 torch、transformers（Apache-2.0）、
  tokenizers（Apache-2.0）、safetensors（Apache-2.0）、huggingface-hub（Apache-2.0）、
  pillow（HPND，即 MIT-CMU 风格）、einshape（Apache-2.0）、dm-tree（Apache-2.0）、
  jinja2 / markupsafe（BSD-3-Clause）、sympy（BSD-3-Clause）、networkx（BSD-3-Clause）、
  requests（Apache-2.0）、urllib3（MIT）、idna（BSD-3-Clause）、charset-normalizer（MIT）、
  filelock（Unlicense）、fsspec（BSD-3-Clause）、regex（`Apache-2.0 AND CNRI-Python`）、
  pyyaml（MIT）、absl-py（Apache-2.0）、attrs（MIT）、wrapt（BSD-2-Clause）、
  typing-extensions（PSF）、colorama（BSD-3-Clause）、setuptools（MIT）、mpmath（BSD-3-Clause）
  等传递依赖。实测 34 个 wheel，177 MB。
- **torch**：**BSD-3-Clause（wheel 内另含其它组件，见 wheel 内 `LICENSE`）**。
  本文档原来只写「BSD-3-Clause」，比实际窄：PyPI 上 2.14.0 的 license 表达式实测是
  `Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause
  AND BSL-1.0 AND MIT` —— torch 的主体是 BSD-3-Clause，但 wheel 里静态链进了一批
  第三方组件（LLVM、Boost 等），一个词概括不了。
- **MPL-2.0 的两个包要单独列**：MPL §3.2 要求告知接收方如何取得这些文件的源码，
  一句「见各 wheel 内的 METADATA」不算履行：

  | 包 | 许可证 | 源码获取地址 |
  | --- | --- | --- |
  | `certifi` | MPL-2.0 | https://github.com/certifi/python-certifi |
  | `tqdm` | MPL-2.0 + MIT（双许可） | https://github.com/tqdm/tqdm |

  这两行也写进了包内的 `THIRD-PARTY-LICENSES.txt`，用户拿到包就能看到。

**核验方式**：`node desktop/scripts/scan-wheel-licenses.mjs` —— 读 `release/extensions/`
下的 manifest，把每个 wheel 拿 PyPI JSON API 查 `license_expression` + `classifiers`，
命中 GPL / AGPL / LGPL / SSPL / 非商用 就退出码 1。**每次重打拓展包后跑一遍**，
依赖版本一变，传递依赖就可能换。

---

## 10. vendor 进仓库的第三方源码

不是 npm 依赖，是直接复制进仓库的源码。每个文件头各有来源注释，这里是中央清单。

| 内容 | 位置 | 来源 | 许可证 |
|---|---|---|---|
| Magic UI 组件：number-ticker、blur-fade、animated-circular-progress-bar、typing-animation、word-rotate | `src/cards/magicui/vendor/*.tsx` | https://github.com/magicuidesign/magicui | MIT |
| Magic UI 动画样式（22 组 `@keyframes` 与同名 class，抠自 `apps/www/styles/globals.css`） | `src/cards/magicui/vendor/magicui-animations.css` | 同上 | MIT |
| `cn.ts`（自写的极简替代，不是 shadcn 那份） | `src/cards/magicui/vendor/cn.ts` | 本项目 | — |
| Magic UI 可搬目录：全部 78 个组件的原始源码 + `index.json`（不参与编译，供模型按需导入） | `server/catalog/magicui/` | 同上 | MIT |
| Lottie 素材：lottie-web 仓库 `demo/` 下的 5 个演示动画（adrock、bodymovin、gatin、happy2016、navidad） | `server/catalog/lottie/` | https://github.com/airbnb/lottie-web | MIT（随仓库） |
| 粒子配置：从 `@tsparticles/configs` 导出、经导出管线实跑筛选的配置 JSON | `server/catalog/particles/` | https://github.com/tsparticles/tsparticles | MIT |

`create_card` 的审查门要求每一张搬进来的卡在文件头声明来源和许可证，并拒绝 Commons Clause / Hippocratic / 专有 / GSAP。经它导入的卡落在 `src/cards/user/`，随安装包分发前把它们补进这张表。

## 分发前检查清单

- [x] 运行 `cargo deny check licenses` 确认 Rust 依赖许可证兼容 ——
      **2026-09-08 已核**：`licenses ok`。白名单配置在 `desktop/src-tauri/deny.toml`，
      引进新许可证会当场失败。逐条见第 4 节；MPL-2.0 那 5 个的源码获取说明也在那儿。
      **换依赖就要重跑**
- [x] 运行 `npx license-checker --summary` 确认 npm 依赖许可证兼容 ——
      **2026-09-08 已核**：241 个包，MIT 217 / ISC 8 / Apache-2.0 7 / MPL-2.0 4 /
      BSD-3-Clause 2 / BSD-2-Clause 1 / 0BSD 1，无 GPL 系。逐条见第 6 节。
      **换依赖就要重跑**
- [ ] 确认 `runtime/ffmpeg/LICENSE` 文件存在且包含 GPL v3 全文
- [ ] 确认 ffmpeg 源码获取途径文档已写入安装包或官网
- [ ] 确认 Chrome for Testing 的再分发条款允许捆绑分发
- [ ] 确认 WebView2 SDK 许可条款允许 downloadBootstrapper 模式
- [ ] 确认内置 Python 版本的 PSF License 条款
- [ ] 新写的 `promptcut_*` 代码里，凡是算法或结构移植自第三方仓库的，在第 7.2 节登记，
      并把该许可证全文放进同一个包目录（`prepare-python.mjs` 会连同 LICENSE 文件一起
      复制进 `site-packages`，随主安装包发出去）
- [ ] 每加一个随拓展包分发的模型权重，在第 9 节登记，并核实其许可证允许再分发
      （注意有的模型是 CC-BY-NC 之类的非商业授权，**不能**随包发）。
      **核实到模型目录，不要只看根仓库**——YuNet 就是这么标错的，见第 9 节
- [x] 核实拓展包内各 wheel 的许可证 —— **2026-09-07 已核**：
      `node desktop/scripts/scan-wheel-licenses.mjs`（读 `release/extensions/` 下的
      manifest，逐个查 PyPI 的 `license_expression` + `classifiers`）。脚本扫的是该目录下
      **所有** manifest（含 shots / track / stt 单项包），2026-09-07 实测共 45 个包；
      其中 light + full 两档自己是 34 个。**0 个命中 GPL / AGPL / LGPL / SSPL / 非商用**；MPL-2.0 的
      certifi、tqdm 已按 §3.2 在第 9 节和包内 `THIRD-PARTY-LICENSES.txt` 给出源码地址。
      **依赖版本一变就要重跑**（`pip download` 的传递依赖会换）
- [x] 拓展包内附许可证全文 —— **2026-09-07 起**由 `make-extension.mjs` 把 MIT /
      Apache-2.0 / BSD-3-Clause 三份全文写进包内 `THIRD-PARTY-LICENSES.txt`，
      `apply-extension.ps1` 再按包名拷到 `%APPDATA%\com.promptcut.desktop\models\THIRD-PARTY-LICENSES-<包名>.txt`。
      在此之前的包**只有许可证名字没有正文，不合规，不要再发**
- [ ] 评估 YuNet 的数据集条款（权重 MIT，训练集 WIDER FACE 非商用）是否可接受；
      不接受就把它从 `MODEL_META` 里去掉，主体检测退回只用 RT-DETR 的人体框
- [ ] 若要签名发布，获取代码签名证书并配置 Tauri 签名

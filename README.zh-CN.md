<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="PromptCut 标识">
</p>

<h1 align="center">PromptCut Community</h1>

<p align="center">
  <strong>用一句话让 AI Agent 剪视频，你随时可以接手。</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-3a3f4b?style=for-the-badge" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/简体中文-00A3A3?style=for-the-badge" alt="简体中文"></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/日本語-3a3f4b?style=for-the-badge" alt="日本語"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6F69FC" alt="MIT 许可证"></a>
  <a href="https://github.com/Nice9Tian/PromptCut_Community/actions/workflows/test.yml"><img src="https://github.com/Nice9Tian/PromptCut_Community/actions/workflows/test.yml/badge.svg" alt="测试状态"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A3A3" alt="Node.js 22 或更新">
  <img src="https://img.shields.io/badge/desktop-Windows%20x64-3a3f4b" alt="桌面版：Windows x64">
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-00A3A3" alt="欢迎提 PR"></a>
</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#跑起来">跑起来</a> ·
  <a href="#文档">文档</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <img src="docs/assets/editor.webp" width="900" alt="PromptCut 编辑器：左边素材库，中间预览，右边 Agent 面板，下方时间轴">
</p>

PromptCut 是一个 AI 视频剪辑工作台：用自然语言指挥 Agent 完成剪辑，也可以自己动手剪辑、调整参数，两者可以并行。

**本仓库是社区版**：在本机和局域网里用——桌面应用与本机浏览器；同一个局域网里的另一台电脑或手机可以扫码加入共享项目、一起编辑。社区版不需要注册账号。网站账号、云端项目、托管服务和网页在线版留在闭源的商业版里。

> [!NOTE]
> 软件界面目前只有中文。英文和日文正在做，见 [issue #6](https://github.com/Nice9Tian/PromptCut_Community/issues/6)。

## 能做什么

| | |
|---|---|
| **AI 指挥剪辑** | 接本机的 CLI / API Agent，用一句话让它排时间轴、加卡片、调参数；也作为 MCP 服务器被别的 Agent 调用。 |
| **手动剪辑** | 时间轴、多轨、剪辑段嵌套、参数面板、预览。 |
| **卡片** | 动效、图表、字幕等以 React 组件实现的「卡片」，自带一套内置库，可以自己写。 |
| **渲染与出片** | 预渲染生成快照、本机 Chrome 逐帧渲染、ffmpeg 合成成片。 |
| **素材** | 本地导入、从网页链接抓取（yt-dlp）、镜头切换识别、主体检测、运动追踪、语音转文字。 |
| **局域网共享** | 把项目共享到同一个局域网里，另一台电脑或手机扫码加入，两边实时同步；手机上有专门的界面。 |
| **桌面版** | Tauri v2 外壳，把 Node、Chrome for Testing、ffmpeg、内置 Python 打成一个 Windows 安装包。 |

## 跑起来

需要 Node.js ≥ 22（推荐 24.x）。导出成片还需要 ffmpeg 在 PATH 上（Windows：`winget install --id Gyan.FFmpeg -e`）。

```bash
npm ci
npm run dev        # 本机编辑器，http://127.0.0.1:5190
```

| 命令 | 做什么 |
|---|---|
| `npm run dev` | 起本机编辑器（Vite dev server，后端逻辑在它的插件中间件里） |
| `npm test` | 全量单测 |
| `npm run build` | 先类型检查再构建 |
| `npx tsc -b` | 只做类型检查 |

Python 侧（语音转文字、镜头识别、主体检测、追踪、素材收集）的依赖和模型权重按需装，没装会在 `status` 里如实报告，见 [python/README.md](python/README.md)。桌面版的构建见 [desktop/README.md](desktop/README.md)。

## 文档

`docs/semantics/` 是这个项目的**契约**：语义与代码冲突时以语义为准。改代码前先按 [docs/semantics/README.md](docs/semantics/README.md) 的表找出该读哪几份。

| 想了解 | 看这里 |
|---|---|
| 产品为什么存在、要达到什么 | [docs/semantics/product-purpose.md](docs/semantics/product-purpose.md) |
| 系统由哪几部分组成 | [docs/semantics/architecture.md](docs/semantics/architecture.md)，产品功能在 [product/](docs/semantics/product/)，具体机制在 [mechanism/](docs/semantics/mechanism/) |
| 用户怎么用 | [docs/semantics/user-workflow.md](docs/semantics/user-workflow.md)，细节在 [workflow/](docs/semantics/workflow/) |
| 术语 | [docs/semantics/glossary.md](docs/semantics/glossary.md) |
| 为什么这样设计 | [docs/rationale/](docs/rationale/) |
| 排障、对账等操作知识 | [docs/guides/](docs/guides/) |
| 怎么参与 | [CONTRIBUTING.md](CONTRIBUTING.md) |

<details>
<summary><strong>关于指向本仓库之外的引用</strong></summary>

代码注释和语义文档里偶尔会引用本仓库里没有的东西，有两类：

- **上游的内部文档**：`docs/plan/…`（计划与契约）、`docs/reports/…`（验收报告），以及 `docs/local.md`（本机环境记录，按设计从来不入任何仓库，见 `docs/semantics/guide_files/constraints.md`）。
- **商业版独有的代码**：在商业版仓库的 `cloud/` 下（例如 `cloud/src/account/…`、`cloud/server/hosted/…`；较早的注释里也会写成搬家前的 `src/account/…`、`server/hosted/…`），以及 `ONLINE_BUILD` 这类在社区版里恒为假的编译期常量。

两类引用都故意保留着，因为它们说明了某个决定的出处，而注释本身已经把结论写清楚了——读不到被引用的文件，不影响你理解这段代码。本地与云端的接缝已经拆开：共享代码只认接口和注册表，商业版在 `cloud/` 里把自己的实现登记上去；社区版里这些槽位用的是自带的本地实现。

</details>

<details>
<summary><strong>给 coding agent 的入口</strong></summary>

本仓库**不放** `AGENTS.md` 和 `CLAUDE.md`：这两个文件会被各家工具无条件注入上下文，把本项目的协作习惯塞进别人的 Agent。需要的话自己在工作副本里建一份，内容照抄下面这段就够，别提交（`.gitignore` 已挡掉）：

````markdown
# PromptCut

AI 视频剪辑工作台。改这个仓库之前先知道这几件事：

- 语义库在 `docs/semantics/`：产品承诺在 `product/`，实现机制在 `mechanism/`，用户流程在 `workflow/`。语义与代码冲突时以语义为准。
- 硬约束在 `docs/semantics/guide_files/constraints.md`，必须守。其中分层是 kernel ← render ← editor / mcp / ai，下层不引用上层，守门测试会拦。
- 怎么验证、什么改动必跑哪一项，在 `docs/semantics/guide_files/verification.md`。
- 按改动范围该读哪几份语义，见 `docs/semantics/README.md`。
````

</details>

## 许可证与名字

代码按 [MIT](LICENSE) 授权，**"PromptCut" 这个名字和相关标识不在授权范围内**。可以自由 fork、修改、再分发，但请不要用 "PromptCut" 命名你的分发版本，以免用户把它当成本项目的官方版本。

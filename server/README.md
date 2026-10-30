# PromptCut 服务端 

此目录包含 AI 助手后端集成，包括 Vite 插件、MCP 服务和 STT 集成。

## 端点
* `GET /api/ai/providers[?refresh=1]` - 返回 `{ ok, providers, stt }`。获取可用的运行器及 STT 状态。`providers` 中的每一项现在多包含一个 `auth` 字段（形状为 `{ loggedIn: true|false|null, detail?, fixHint?, loginCommand? }`，数据来自 `server/runners/auth.mjs` 的 `probeAuth` 探测，结果默认缓存 10 秒）。加上 `refresh=1` 查询参数可跳过 provider 缓存（5 秒）和 auth 缓存（10 秒）。列表除了三大 CLI，还固定包含第四项 `id` 为 `api`（API 直连）；若 `server/runners/api.mjs` 缺失，它是 `available: false` 加 `note` 为 "api runner 缺失" 的占位项。
* `POST /api/ai/login` - 接收 `{ provider, deviceAuth? }`，返回 `{ ok, job }`。后台运行官方登录命令，必要时打开浏览器；不弹命令行。Antigravity 使用独立 ConPTY 子进程执行 `models`，不进入 TUI 或 Trust 界面。退出后再次验证认证，只有验证通过才标记成功。
* `POST /api/ai/install` - 接收 `{ provider, dryRun? }`。Windows 下后台运行三家官方原生安装器，无需用户预装 npm。下载脚本重试、进程超时、退出码和安装后的可执行文件验证均纳入任务状态。
* `GET /api/ai/setup` - 返回 `{ ok, jobs }`，每家最多一个活动任务。状态为 `running / succeeded / failed`；携带进度、安装日志、必要的官方登录链接或设备码。关闭设置窗口后任务继续，重新打开会恢复进度。原始登录输出不会返回或落盘。
* `DELETE /api/ai/setup` - 接收 `{ provider }`，停止该任务的进程树，退出后可重试。设置写入端点只接受 JSON，并拒绝跨来源请求。
* `GET /api/ai/config` / `POST /api/ai/config` - 读写 `%LOCALAPPDATA%\promptcut\ai.json`（测试时可通过环境变量 `PROMPTCUT_AI_CONFIG` 覆盖路径）。**返回值里的 `apiKey` 永远是 `{ set, last4 }` 的脱敏结构，绝不回显原文。** POST 接收部分更新配置对象，进行深合并；`apiKey` 传空串或缺失时保持原值，传 `null` 则清空。其中 `vendor` 仅支持 `anthropic`/`openai`/`gemini`，`baseUrl` 必须是 HTTP/HTTPS 地址或留空，`defaultProvider` 仅支持 `claude`/`agy`/`codex`/`api`/`null`，非法参数返回 400。非 GET/POST 请求返回 405。
* `GET /api/ai/machine-code` - 返回 `{ ok, code }`,形如 `PCM-4HNS5-DRRD0-S1Z7S-S15ZQ`。这台机器的识别码,由机器级标识(Windows 取 MachineGuid,macOS 取 IOPlatformUUID,Linux 取 machine-id,都取不到就退回主机名+平台+网卡)做 SHA-256 后取 Crockford Base32 前 20 位。**只返回摘要,原始指纹不出服务端。**
* `GET /api/ai/agy-permissions` / `POST /api/ai/agy-permissions` - 读写 agy 的权限配置文件（默认 `~/.gemini/antigravity-cli/settings.json`，可通过环境变量 `PROMPTCUT_AGY_SETTINGS` 覆盖）。GET 请求返回 `{ path, total, granted, missing }`。POST 请求将 `missing` 列表全部加入 `permissions.allow` 数组并保存，返回 `{ path, added, total }`。非 GET/POST 请求返回 405。
* `POST /api/ai/chat` - 发送 AI 对话请求（SSE 流式响应）。
* `POST /api/ai/abort` - 中止指定的对话请求。
* `GET /api/mcp/events` - 编辑台连接到 MCP 的 SSE 事件流。
* `POST /api/mcp/result` - 编辑台返回的 MCP 工具执行结果。
* `POST /api/mcp/call` - MCP server 向编辑台请求工具调用。
* `GET /api/mcp/status` - 获取当前 MCP 连接状态（调试用）。
* `POST /api/vision/sheet` - 接收 `{ media, start, end, grid }`，用 ffmpeg 把素材这一段等间隔抽 4 或 9 帧拼成一张 JPEG（`__image`），按文件、修改时间、区间、格数缓存在 `out/sheets/`。是 MCP 工具 `see_frames` 素材模式（`source: "media"`，按镜头分页看素材画面）的服务端一半；规划逻辑在 `src/ai/sequences.ts`。

### 多 Agent 并行

AI 面板的分页栏、Agent 之间的范围声明与互相通知（`declare_scope` / `list_agents` / `send_message` / `check_messages`），以及 `conversationId → PROMPTCUT_AGENT` 的透传，见 [docs/archive/topics/multi-agent.md](../docs/archive/topics/multi-agent.md)。

### 约定封装（src/kernel/envelope.ts）

* MCP 工具 `get_clip({ clipId })` / `set_clip({ clipId, envelope })`：Agent 看到和改的都是这份固定形状的封装（card + lifecycle / time / frame / blend / motion / parts / params），不是原始 clip，更不是组件源码。左栏「编辑 → 代码」显示和编辑的也是它，两边走同一个 `applyEnvelope`：只写有差异的段、任一处不合法整份不写。
* 卡片契约多了 `parts`（部件树）和 `lifecycle`（进场落定时刻、之后停住 / 循环 / 持续变化、支持的退场），见 `server/card-authoring-guide.md`。
* 素材封装卡：`server/catalog` 里的 Lottie / 粒子配置在构建时各自翻译成一张卡（`src/cards/assets`，id 前缀 `lottie-` / `particles-`，create_card 不许占），粒子卡的旋钮由 `particlesKnobs.ts` 从配置里翻译出来（配置里有的才露）。

### CLI 额度阈值熔断（server/runners/quota.mjs）

* Claude Code / Codex 驱动的额度记账与熔断,`GET /api/ai/quota` 看当前额度;机制说明见 [server/runners/QUOTA.md](runners/QUOTA.md)。

### 参数兼容模式（server/harness/schema.mjs）

* 工具参数的 JSON Schema 有两档：完整的（Claude / GPT 系吃得下 `additionalProperties`、`default`、`format` 这些）和 Gemini 那套最窄的子集。清洗由 `sanitizeSchema(schema, vendor, { compat })` 做，`compat` 和厂商字段解耦——走 OpenAI 兼容接口的 Router 也可能接的是 Gemini。
* 前端请求带 `schemaCompat`：`on` / `off` 是定论，`auto` 由 `server/runners/api.mjs` 按厂商字段和模型名（含 gemini 就开）再推一次。AI 面板模型栏的「参数兼容」按钮：Claude Code / Codex 和模型名带 claude / gpt / o 系的锁死关，Antigravity 和模型名带 gemini 的锁死开，别家模型用户自己点（策略在 `src/ai/modelOptions.ts` 的 `compatPolicy`）。三条 CLI 路本来就各自走原生协议，这个开关只影响 API 直连 / Router。

### 部件库与组合卡（src/parts、src/kernel/parts.ts）

* 部件（`PartDef`，src/kernel/partTypes.ts）是可独立渲染的最小单元，一个文件一个放在 src/parts/lib/，glob 自动收集；组合卡（cardId `composite`）的 `clip.parts` 是一棵部件实例树，舞台（render/PartTree.tsx）按树逐级渲染摆位，每个实例的框相对父框、进场时机相对父级。
* MCP 工具 `list_parts`、`add_composite`、`add_part`、`set_part`、`remove_part`、`move_part`；`get_clip` / `set_clip` 对组合卡返回 / 接受整棵实例树（带 partId、frame.local 可写、frame.world 只读、settleMs）。树的增删改移和校验都是 kernel/parts.ts 的纯函数，参数面板（PartsForm）和 Agent 走同一条路。

### SKILL：桌面 APP 经 MCP 直连（server/vite-plugin-skill.ts、server/mcp-server.mjs）

* 桌面 APP（Claude Code、Codex）的每个会话起一份 `server/mcp-server.mjs`，按 `%TEMP%promptcutport.json`（或 `PROMPTCUT_PORT`、
  `PROMPTCUT_PORT_FILE`）找用户正在用的实例；每个会话一个身份（`desk-…`，Claude Code 一个进程一个会话，Codex 按 `_meta.threadId`），
  厂商从 `initialize` 的 `clientInfo` 认。调用经 `POST /api/mcp/call`（带 `caller`）落到和 AI 栏同一条路：登记表、SKILL 闸
  （只拦桌面会话、只在 SKILL 模式关着时拦）、创造力等级（跟项目）、文档服务的写入身份、公告板与「用户正在编辑」提示。
* `GET /api/agent/desktop` - 桌面会话的分组（厂商、正在进行的操作、最近的调用、进度报告）；页面也收 SSE 的 `agent.desktop`。
* `GET /api/skill/desktop-register`、`POST /api/skill/desktop-register { target: "claude-code" | "codex", action: "register" | "unregister" }` -
  把 MCP 服务登记到用户级配置（`server/desktop-register.mjs`：条目名固定 `promptcut`、不写端口、写之前备份到 `<skillRoot>/mcp-register/`、
  撤销只还原这一条）。测试用 `PROMPTCUT_CLAUDE_CONFIG`、`PROMPTCUT_CODEX_CONFIG`、`PROMPTCUT_SKILL_DIR` 指到临时目录。
* 原来的「任务目录 + 无头实例 + 深链拉起新对话 + `submit_merge` 三方合并」已归档（计划 `docs/plan/agent-workflow-plan.md` A4）。

### 素材收集（server/vite-plugin-collect.ts）
从网页链接（B 站等）抓视频，落到素材目录 `out/media`（和上传同一个目录，所以 `/@media/<文件名>` 直接能取）。干活的是 `python/promptcut_collect`（yt-dlp 封装，见 [python/README.md](../python/README.md)），这边只起进程、解析 JSONL、管作业表。
* `GET /api/collect/status` - `{ ok, python, ready, ytdlp: { installed, version, error }, ffmpeg, presets }`。`ready` 要求 yt-dlp 装了且 ffmpeg 找得到。
* `POST /api/collect/install` - 无 body。pip 装 yt-dlp（约 3 MB），SSE 流式回 pip 日志（`log` / `installed` / `error` 事件）。
* `POST /api/collect/search` - `{ query, site?, limit? }`，站内搜索（bilibili 默认 / generic 搜 YouTube；limit 1~10，默认 5）。先用 yt-dlp 的搜索抽取器扁平拿链接，再并发探测每条拿 `title / duration / uploader / view_count / max_height`（实测 3 条约 3 秒）；单条失败只带 `error`。给 agent「按主题找素材」用，MCP 工具 `collect_search`。
* `POST /api/collect/probe` - `{ url, site?, quality? }`，同步探测（上限 50 秒），返回 `{ ok, title, duration, uploader, heights, parts, subtitles, formats, notes }`；失败 `{ ok:false, error, notInstalled?, notes }`。
* `POST /api/collect/download` - `{ url, quality?, site?, audioOnly?, allParts?, keepCodec?, cookies? }`，立刻返回 `{ ok, jobId, outDir }`。同一条链接正在下时返回已有的 jobId 并带 `reused: true`。
* `GET /api/collect/job/<id>` - `{ ok, job }`。`job` 含 `status`（running / done / error）、`stage`（starting / video / audio / merge / transcode / done）、`percent`、`speed`、`eta`、`info`、`items`（每个文件的 `path` / `url` / 标题 / 时长 / 分辨率 / `vcodec` / `transcoded`）、`notes`（412 重试记录）、`message`（出错原因）。作业只在内存里，重启后 404。
* `DELETE /api/collect/job/<id>` - 取消：杀掉整棵进程树，`status` 变 error、`message` 为「已取消」。
* `GET /api/collect/jobs` - 全部作业，新的在前。

**登录态**（`server/collect-cookies.mjs` 纯逻辑，可单测；浏览器那半边借 `server/web/` 的 agent 浏览器）。yt-dlp 读不了 Chrome / Edge 的 cookie 库（Windows 应用绑定加密，实测两家都是 `Could not copy cookie database`），所以让用户在 agent 的浏览器窗口里扫码登录，再从 CDP `Network.getAllCookies` 取出来存成 Netscape 格式的 `<dataDir>/cookies/<site>.txt`，之后探测和下载自动带上。
* `POST /api/collect/login` - `{ site?: "bilibili", force? }`。已登录且没过期回 `{ alreadyLoggedIn: true, userId, expiresAt }`；否则打开站点登录页并把浏览器窗口挪到用户面前，回 `{ visible: true, message }`。
* `POST /api/collect/login/check` - `{ site?, hide? }`。从浏览器取 cookie，`SESSDATA / bili_jct / DedeUserID` 齐了且没过期就存盘、藏回窗口，回 `{ loggedIn: true, userId, expiresAt, path, count }`；否则 `{ loggedIn: false, missing, expired, hint }`。
* `GET /api/collect/cookies` - 各站存盘登录态 `{ bilibili: { name, loggedIn, expired, userId, expiresAt, path } }`；`/status` 的返回里也带同一份 `cookies`。
* `DELETE /api/collect/cookies?site=bilibili` - 退出登录（删文件）。
* `probe` / `download` 没传 `cookies` 时按链接判断站点、自动带上没过期的存盘登录态；作业的 `cookiesUsed` 和 `notes` 说明带没带、为什么没带。

MCP 工具 `collect_login / collect_login_check / collect_logout`。验证：`node --test server/test/collect-cookies.test.mjs`。

扫码登录（接口版，不开浏览器）：`POST /api/collect/qr/start` → `{ key, url, svgUrl, expiresIn }`，二维码由 `server/qr.mjs`（零依赖的 QR 编码器，已和 Python qrcode 库逐模块对拍、jsQR 实测能解）现画；`GET /api/collect/qr/svg?key=` 出 SVG；`GET /api/collect/qr/poll?key=` 回 `state`（waiting / scanned / expired / ok），ok 时登录态已存盘。逻辑在 `server/collect-qr-login.mjs`，编辑台里的登录框 `src/editor/right/CollectLoginDialog.tsx` 两个页签：扫码（这条）和账号密码（打开站点登录页，走 agent 浏览器）。

### Agent 浏览器的壳模式（server/web/browser.mjs）
桌面壳给 WebView2 开了调试端口并通过 `PROMPTCUT_AGENT_CDP` 传给 sidecar 时，`getBrowser` 走 `connectShell`：连 `http://127.0.0.1:<port>`，按壳注入的 `window.__PROMPTCUT_AGENT__` 标记认出 agent 那块子 webview（热重启后重连也认得），实例带 `shell: true`、`shared: true`（关的时候只断开）。`showWindow / hideWindow` 在壳模式下不动窗口，只解除 / 恢复视口仿真并回 `{ shell: true }`；`web_handoff` 的返回带 `shell`，由前端点亮顶栏「浏览器」页签、用户点开面板后 invoke 壳命令把 webview 摆到位。没有这个变量（浏览器里 `npm run dev`）就退回离屏 Chrome（已加 `--mute-audio`、压掉欢迎页和恢复气泡）。详见 [desktop/README.md](../desktop/README.md) 的「Agent 的浏览器」一节。

前端胶水在 `src/ai/collect.ts`；MCP 工具 `collect_status / collect_install / collect_probe / collect_download / collect_job` 的实现在 `src/editor/right/index.tsx`，下完自动用 `importVideoFromServer`（`src/editor/io/index.ts`）登记进素材库、放到视频轨，不再上传一遍。角色卡 `src/ai/roles/collector.md`（素材收集员）。

验证：`node --test server/test/collect-plugin.test.mjs`（用 `server/test/fake-collect.cmd` 冒充 Python，不联网）；真实链路见 python/README.md 的实测记录。

## 登录状态探测（server/runners/auth.mjs）
- Claude：以 `claude auth status` 的 JSON 为准。
- Codex：合并 stdout/stderr 读取 `codex login status`。安装、登录和执行统一使用 `%LOCALAPPDATA%\promptcut\cli\codex-home`，不会修改 Codex 桌面应用的配置或凭据。用户需在 PromptCut 内登录一次。
- Antigravity：以后台 `agy models` 成功返回模型列表确认连接。未登录时通过隐藏 ConPTY 完成 OAuth，界面只显示浏览器授权入口。

CLI 管理目录默认为 `%LOCALAPPDATA%\promptcut\cli`，测试可通过 `PROMPTCUT_CLI_HOME` 覆盖。检测每次重新解析实际路径，支持用户目录、官方安装路径、npm shim 和 PATH。npm shim 优先由软件自带 Node 直接执行其包入口，以保留含中文、空格和 JSON 的参数。

后台登录依赖 `node-pty`，桌面打包流程会验证其原生组件可用。开发时修改 server/runners 的 mjs 后应完整重启服务（Node 动态 import 存在模块缓存）。

验证：`node --test server/test/cli-setup.test.mjs`、`node server/runners/agy-login.mjs --self-test`、`npm run build`。

官方参考：[Claude 安装](https://code.claude.com/docs/en/setup)、[Codex 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Antigravity 安装与认证](https://www.antigravity.google/docs/cli/install/)。

## 配置文件 ai.json
默认存储于 `%LOCALAPPDATA%\promptcut\ai.json`。它的完整形状如下：
```json
{
  "version": 1,
  "defaultProvider": null,
  "toolProtocol": false,
  "api": {
    "vendor": "anthropic",
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "maxTokens": 4096,
    "source": "",
    "profiles": {
      "custom": { "vendor": "anthropic", "baseUrl": "", "model": "" },
      "router": { "vendor": "anthropic", "baseUrl": "", "model": "" }
    }
  },
  "cliModels": { "claude": "opus|sonnet|haiku", "codex": "", "agy": "" }
}
```
`profiles` 是两路(自定义 API / Router 导入)各自的连接配置;顶层的 `vendor` / `baseUrl` / `model` 是**当前生效那一路**(`source`)的镜像,
下游(runner、面板的模型选择器)只读它们。`model`(以及 `cliModels.*`)用 `|` 分隔多个备选,面板输入框旁边能切,不选就用第一个。
POST `/api/ai/config` 时:`api.profiles.custom / router` 各写各的;老写法的顶层 `vendor / baseUrl / model` 写进目标那一路
(带 `source` 就是那一路,不带就是当前生效的那一路)。老版本没有 `profiles` 的 ai.json 读的时候会把顶层那份搬进当前那一路。
**强调**：`apiKey` 仅存在于服务端进程内存中使用，绝不写入普通日志、绝不出现在事件流中，也绝不通过任何接口回显给前端。

## 端口发现顺序
1. 环境变量 `PROMPTCUT_PORT`。
2. `%TEMP%\promptcut\port.json`。该锁文件现在除了 `port` 外还带有 `host` 字段（桥实际监听地址，`::` 或 `0.0.0.0` 会被规范化成 `127.0.0.1`）。`mcp-server.mjs` 调用桥的探测请求地址顺序为：锁文件 `host` → `127.0.0.1` → `[::1]` → `localhost`，**并且只有遇到 ECONNREFUSED 才会回退至下一个地址**。为避免因 Windows 系统下 `localhost` 可能只解析到 IPv6 `::1` 导致双栈连接失败，`server/vite.ai.config.ts` 已强制将 `server.host` 固定成 `127.0.0.1`。
3. 默认 5177。

## 运行测试
- `node server/test/auth-smoke.mjs`：打印三家登录探测结果，并使用临时文件测试 `ai-config` 的读写与密码脱敏机制。完全离线进行，不消耗任何额度和网络。
- `node server/test/mcp-smoke.mjs`：**自包含端到端** 冒烟测试。如果 5196 端口上没有桥，它会自行使用 `node node_modules/vite/bin/vite.js --config server/vite.ai.config.ts` 启动一个，等待就绪后依次执行 `initialize` / `tools/list` / 编辑台未连 / 编辑台已连（自动拉起 `server/test/fake-editor.mjs`）四组用例，收尾使用 `taskkill` 把自己起的 vite 整棵进程树杀掉并确认 5196 端口释放。如果 5196 上已经有桥则直接复用，**测试后不杀进程**。当环境变量 `PROMPTCUT_SMOKE_NO_BRIDGE=1` 时，可跳过起桥过程（此时仅跑前两组用例加断桥情况下的错误文本验证）。
  期望输出（启动桥，并且拉起编辑器的情况）：
  ```
  PASS: initialize
  PASS: tools/list
  PASS: tools/call (bridge up, editor down)
  PASS: tools/call (bridge up, editor up)
  ALL PASS
  [cleanup] 5196 已释放
  ```
- `node server/test/p1-verify.mjs`：第七轮的综合端到端验证测试，用于确保主线任务能够成功跑通。

## 环境变量开关
- `PROMPTCUT_AI_FAKE_RUNNER`: 设为 `1` 时，强制加载内置的 `server/test/fake-runner.mjs`（用于测试流程，避免消耗真实 API 的 Token）。
- `PROMPTCUT_AI_RUNNER_MODULE`: 指定动态加载 runner 的路径（默认 `./runners/index.mjs`）。如果指定的 runner 加载失败或不存在，调用接口将返回 503 错误，并说明 Runner 未就绪。
- `PROMPTCUT_AI_CONFIG`: 覆盖默认的配置文件路径，指定自定义的 `ai.json` 路径，用于测试。
- `PROMPTCUT_AGY_SETTINGS`: 覆盖 agy 的 settings.json 路径，用于测试权限相关功能。
- `PROMPTCUT_SMOKE_NO_BRIDGE`: 设为 `1` 时，在 `mcp-smoke.mjs` 测试中不自动启动 Vite 测试桥。

## 语音识别（STT）配置
引擎按以下顺序优先级选择：
1. 环境变量 `PROMPTCUT_STT_CMD`。
2. `%LOCALAPPDATA%\promptcut\stt.json` 里的 `cmd` 字段。
3. 自动检测 `cuda_Vit` conda 环境中的 `faster-whisper`。
4. 若未找到，默认提示需安装 `faster-whisper`。

## API 配置的加密分发与落盘加密

两处用的是同一套信封:PBKDF2-SHA256(60 万轮,轮数写在密文头里)+ AES-256-GCM,只有口令和 AAD 不同。

**分发**(`src/ai/configShare.ts`,前缀 `PCAI1.`,AAD `PromptCut-api-share-v1`)
接收方在「AI 设置 → API 直连 → 导入分发来的配置」里拿到本机识别码发给分发方;分发方加密后把密文发回去;接收方粘贴后本机自动解开并写入配置。分发方有两个等价的工具,产出的密文可以互相解开:双击根目录的 `make-api-share.bat` 打开 Rust 图形界面(`tools/api-share-gui`,首次运行会自动 `cargo build --release`),或者跑 `tools/make-api-share.py`(需要 `pip install cryptography`,适合脚本化)。密文里带可选的 `note` 和 `expiresAt`,过期的拒绝导入。识别码抄错大小写、漏掉分隔符、把 0 抄成 O 都能容错,聊天软件插的换行也会被去掉。**软件里只有接收侧,没有制作侧**——制作密文是分发方自己的事。

**落盘**(`server/runners/config-crypt.mjs`,前缀 `PCENC1.`,AAD `PromptCut-config-at-rest-v1`)
`ai.json` 里的 `apiKey` 以密文存储,口令是本机指纹。`readConfig()` 读出来就解开,`writeConfig()` 写进去前加密,所以下游(providers、`publicConfig`)一行都不用改。老配置里的明文 Key 原样读出,下次写入时自动转成密文;解不开(比如把配置拷到别的机器)按「没设 Key」处理,不抛错。

**这套东西挡什么、不挡什么**:挡的是明文在传输和磁盘上裸奔——邮件、聊天记录、同步盘、备份、误提交、截屏,以及密文被转发给第三个人(他机器码不同,解不开)。**挡不住**能在这台机器上以你的身份跑代码的人:口令由机器自己算出,推导逻辑随软件发出去。要更硬的保护应上 Windows DPAPI / macOS Keychain 这类由操作系统托管密钥的方案。真正的用量控制还得靠 API 侧的配额与轮换。

三份实现(TypeScript / Python / Rust)必须逐字节兼容。Rust 侧的测试里钉了一条由 TypeScript 生成的基准密文,跑偏了 `cargo test` 就会红;反向核对用 `cargo test --release -- --ignored --nocapture` 打印一条 Rust 生成的密文,再喂给另外两边解。

验证:`node --test server/test/config-share.test.mjs server/test/config-crypt.test.mjs server/test/machine-id.test.mjs`、`python tools/make-api-share.py --self-test`、`cd tools/api-share-gui && cargo test`。

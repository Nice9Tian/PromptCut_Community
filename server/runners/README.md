# AI CLI 运行器 (Runners)

该模块负责启动和管理与三个主流 AI CLI（Claude Code, Antigravity, Codex）及内部直连（API）的进程交互。

## 模块职责与接口

`server/runners/index.mjs` 暴露了以下核心接口：

```typescript
// 枚举可用的提供商并探测是否安装及版本信息
export async function listProviders(opts?: { refresh: boolean }): Promise<Array<{
  id: "claude" | "agy" | "codex" | "api",
  label: string,
  available: boolean,
  version?: string,
  path?: string,
  note?: string,
  auth?: { loggedIn: boolean | null, detail?: string, fixHint?: string, loginCommand?: string[] }
}>>

// 启动一次会话，返回包含中止句柄和完成 Promise 的对象
export function startRun(opts: {
  provider: "claude" | "agy" | "codex" | "api",
  prompt: string,
  systemPrompt: string,
  sessionId?: string,
  cwd: string,
  model?: string,
  mcp: { serverName: "promptcut", command: string, args: string[], env: Record<string, string> },
  callTool: (name: string, args: any) => Promise<any>,
  onEvent: (ev: RunEvent) => void,
}): { abort(): void, done: Promise<void> }
```

- `listProviders(opts)`：`opts.refresh` 为真时跳过 5 秒缓存。返回的每一项多了 `auth` 字段；末尾固定多一项 `id` 为 `api` 的 provider（通过动态 `import('./api.mjs')` 的 `getApiProvider()` 提供；如果文件缺失或加载失败时，回退为 `available: false` 加 `note` 为 "api runner 缺失" 的占位项，**绝不让整个列表崩掉**）。如果 `api` 项自己没带 `auth`，`index.mjs` 会自动回退调用 `../ai-config.mjs` 的 `publicConfig()` 补齐（以 `apiKey` 是否已设置作为 `loggedIn` 状态）。
- `startRun(opts)`：
  - **新增了 `callTool(name, args) -> Promise` 参数**：桥把 `/api/mcp/call` 的同套分发机制透传给 runner。三家 CLI runner 会忽略它（它们的工具执行走自己的 MCP 服务进程）；只有 api runner（API 直连 harness）用它直接执行工具。由于 `index.mjs` 的 `startRun` 把整个 `opts` 原样透传，它不会挑选过滤字段。
  - 对于 `provider` 为 `api`，`startRun` 会走内部异步分支：若动态 `import('./api.mjs')` 失败，它会通过 `onEvent` 发一条 `error` 事件（绝不抛出异常）；若在 import 完成前被调用了 `abort()`，也会安全等待 `inner` 就绪后立刻使其生效。

### RunEvent 规范
共 7 种事件类型：
- `{type:"session", sessionId}`
- `{type:"text", delta}`
- `{type:"tool_call", name, input}`
- `{type:"tool_result", name, ok, summary}`
- `{type:"status", text}`
- `{type:"done", sessionId?, usage?}`
- `{type:"error", message}`

---

## auth.mjs · 登录状态探测

该模块提供 `probeAuth(providerId, { refresh })` 用于返回三大 CLI 对应的登录状态。
- **配置与规则**：带 10 秒默认缓存。每次探测 `timeout` 5000 毫秒、`windowsHide: true`、永不抛错。
- **红色警戒线**：该模块**不读取、不打印 `~/.codex/config.toml` 的内容**（尊重用户隐私配置）；**绝对不跑任何会把用户登出的命令**。
- `loginCommandFor(providerId)` 根据提供方回传 `['claude', 'auth', 'login']` 等拉起界面的原生命令。

**三家当前环境探测结论实测：**
- **Claude**：执行 `claude auth status` 探测。由于退出码是 1 但 `stdout` 仍是有效的 JSON，解析忽略退出码。实测返回 `loggedIn: false`。
- **Codex**：执行 `codex login status` 探测。本机因 `config.toml` 加载失败（第 5 行的 `model_reasoning_effort` 值本版不认）导致返回 `loggedIn: null` 加提示 `fixHint`。我们不改用户配置。
- **Agy**：由于没有类似状态命令（且未登录时首次运行会自己打开浏览器），永远返回 `loggedIn: null`。

---

## 各家命令行调用格式

### Claude Code
首轮：
```bash
claude -p --output-format stream-json --verbose --include-partial-messages \
  --mcp-config <tmp.json> --strict-mcp-config \
  --allowedTools mcp__promptcut mcp__promptcut__get_editor_state mcp__promptcut__list_effects ... \
  --append-system-prompt <systemPrompt> [--model <m>]
```
注意：`allowedTools` 需要逐个列出每个工具（前缀拼接 `mcp__promptcut__`），并且去掉了 `--permission-mode default` 参数。
续聊（附加参数）：`--resume <sessionId>`
*(Prompt 通过 stdin 传入)*

### Antigravity (agy)
注册 MCP：
```bash
agy mcp add -e PROMPTCUT_PORT=<port> promptcut "<node绝对路径>" "<mcp-server.mjs绝对路径>"
```
首轮及续聊：
```bash
agy -p <prompt> --output-format stream-json --add-dir <cwd> \
  --print-timeout 20m [--conversation <sessionId>] [--model <m>]
```
注意：Agy 提供了一个设置入口，可在前端界面点击齿轮图标，然后点击「授权 PromptCut 工具」自动配置 `~/.gemini/antigravity-cli/settings.json` 的权限规则。
*(系统提示拼接在 Prompt 前面)*

### Codex
首轮：
```bash
codex exec --json --skip-git-repo-check -C <cwd> \
  -c sandbox_mode="read-only" -c approval_policy="never" \
  -c mcp_servers.promptcut.command="<node绝对路径>" \
  -c mcp_servers.promptcut.args=["<mcp-server.mjs绝对路径>"] \
  -c mcp_servers.promptcut.env={PROMPTCUT_PORT="<port>"} \
  -c mcp_servers.promptcut.enabled_tools=["<PromptCut 工具名>",...] \
  -c mcp_servers.promptcut.default_tools_approval_mode="approve" \
  [--model <m>] -
```
注意：`approval_policy="never"` 表示 Codex 不能向用户弹审批；它本身**不会**放行 MCP。
运行器用 `enabled_tools` 逐个限制 PromptCut 工具，再仅对这个 server 设置 `approve`。
`sandbox_mode="read-only"` 仍独立生效，shell 没有随 MCP 一起放开。
续聊：
```bash
codex exec resume <threadId> --json --skip-git-repo-check \
  -c sandbox_mode="read-only" -c approval_policy="never" \
  -c mcp_servers.promptcut.command="<node绝对路径>" ... \
  [--model <m>] -
```
*(Prompt 通过 stdin 传入)*

### 文本协议的触发条件
当以下条件满足时，CLI 运行器会退回或直接使用「文本协议（Text Protocol）」模式（不使用原生 MCP）：
1. 用户在前端设置对话框中主动勾选了「强制使用文本协议」。
2. 原生工具调用被拒：运行器在当前轮次中检测到工具调用由于权限或审批被拒绝（例如 Claude 的 `permission_denials` 非空，Codex 审批被拒，agy 权限被拒）。此时会发出 status 提示，并用文本协议重新执行该轮对话。

---

## 事件字段映射表

### Claude Code -> RunEvent
| Claude 原始 JSON 字段及路径 | 映射到 RunEvent |
|:---|:---|
| `{"type":"system","subtype":"init"}` 的 `session_id` | `session` 事件 |
| `{"type":"system","subtype":"status"}` 的 `status` | `status` 事件 |
| `{"type":"stream_event"}` 下 `content_block_delta` 的 `text_delta.text` | `text` 增量事件 |
| `{"type":"assistant"}` 消息里的 `tool_use` (id/name/input) | `tool_call` 事件 (记录 id->name 映射) |
| `{"type":"user"}` 消息里的 `tool_result` (tool_use_id/is_error/content) | `tool_result` 事件 (通过 id 查找 name) |
| `{"type":"result"}` 的 `is_error: true` (取 `result` / `error.message` / `terminal_reason`) | `error` 事件 |
| `{"type":"result"}` 的 `is_error: false` (取 `session_id` / `usage`) | `done` 事件 |

### Antigravity (agy) -> RunEvent
| agy 原始 JSON 字段及路径 | 映射到 RunEvent |
|:---|:---|
| `{"event":"init"}` 的 `conversation_id` | `session` 事件 |
| `{"event":"step_update"}` 下 `step_type: "tool"` 的 `state: "ACTIVE"` | `tool_call` 事件 (若为 `call_mcp_tool` 则解包 `ToolName` 及 `Arguments`) |
| `{"event":"step_update"}` 下 `step_type: "tool"` 的 `state: "DONE"` | `tool_result` (取 `tool_info.output`) |
| `{"event":"step_update"}` 下 `step_type: "tool"` 的 `state: "ERROR"` | `error` 事件及补充的建议 `status` (权限被拒时) |
| `{"event":"step_update"}` 下 `text_delta` (或 text/delta/content) | `text` 增量事件 (累加到 emitted, 避免后续重复) |
| `{"event":"result"}` 的 `denied_actions` | `status` 补充提醒 |
| `{"event":"result"}` 的 `response` | `text` 补偿补发 |
| `{"event":"result"}` (取 `conversation_id` / `usage`) | `done` 事件 |

### Codex -> RunEvent
| Codex 原始 JSON 字段及路径 | 映射到 RunEvent |
|:---|:---|
| `{"type":"thread.started"}` 的 `thread_id` | `session` 事件 |
| `{"type":"turn.started"}` | `status` 事件 |
| `{"type":"item.*"}` 内的 `agent_message` (text/content) | `text` 增量事件 |
| `{"type":"item.started"}` 内的 `mcp_tool_call` (tool/arguments) | `tool_call` 事件 |
| `{"type":"item.completed"}` 内的 `mcp_tool_call` (status/result) | `tool_result` 事件 |
| `{"type":"mcp_tool_call"}` (顶层备用, status `started` / `completed`) | `tool_call` / `tool_result` 事件 |
| `{"type":"turn.failed"}` 的 `error.message` | 致命 `error` 事件 |
| `{"type":"error"}` 的 `message` | 若含重试信息转 `status`, 否则转 `error` |
| `{"type":"turn.completed"}` 的 `usage` | `done` 事件 |

---

## 已知限制与使用前提

### POST /api/ai/login 实测现象
当尝试通过接口请求启动三种不同 CLI 的登录窗时：
- **Claude**：弹出控制台窗口并运行 `cmd /k claude auth login`。同时 **Chrome 自动弹出了标题为 "Sign in - Claude" 的登录页**。
- **Codex**：仅弹出控制台窗口运行 `cmd /k codex login`，因配置报错立刻退出，**没有**打开浏览器。此时要求用户根据提示 `fixHint` 先修改 `~/.codex/config.toml`。
- **Agy**：弹出控制台窗口运行 `cmd /k agy` 进入了交互式会话，**没有**打开浏览器，由于本机这台机器的 agy 已经是登录状态（如未登录时首次运行会自己打开浏览器）。

### Claude Code
- **登录状态**: 命令行端 OAuth 过期将无法在无头模式使用（报 `api_error`）。用户需要手动在终端执行 `claude` 重新登录后，本运行器才能正常工作。
- **配置与安全隔离**: 传入了 `--strict-mcp-config` 防止将用户配置的全局私人 MCP 工具暴漏给当前对话。
- **工具授权**: 暂使用 `--allowedTools mcp__promptcut`（实测 MCP 能连上且工具前缀为 `mcp__promptcut__*`）。真实免审批情况待用户 OAuth 恢复后复测。

### Codex
- **工作目录与沙箱**: `exec resume` 不支持 `-C` / `-s`，因此依赖于运行器的 `cwd` 和传入的 `-c sandbox_mode="read-only"`。
- **工具授权**: 每次运行都从 `mcp-tools.mjs` 生成 `mcp_servers.promptcut.enabled_tools`，并设置 `mcp_servers.promptcut.default_tools_approval_mode="approve"`；只免批 PromptCut MCP，绝不关闭 shell 沙箱。
- **用户配置覆盖**: 不会自动覆盖用户的 `~/.codex/config.toml` 配置（如 provider 账号问题、`model_reasoning_effort` 不识别问题等），出现此类报错时需用户自行调整 Codex 全局配置。运行器代码严禁读取该配置文件。

### Antigravity (agy)
- **全局注册**: agy 只能全局注册 MCP 服务，无法通过单次运行参数传入配置。运行器会自动识别并在需要时运行注册命令：`agy mcp add -e PROMPTCUT_PORT=<port> promptcut "<node绝对路径>" "<mcp-server.mjs绝对路径>"`。**此操作只会新增/更新名为 `promptcut` 的配置，不会影响其他服务。**如需手动移除可使用：`agy mcp remove promptcut`。
- **续聊索引**: 带有 `--conversation <id>` 续聊时，`step_index` 不会归零而是继续增加。
- **无头权限校验 (非常重要)**: agy 默认的 `request-review` 会自动拒绝无头模式下的未授权工具调用。请见下节。

---

## 必做：agy 的权限配置

当看到类似于 `permission check failed for mcp "promptcut/get_editor_state"` 的错误时，**必须手动授权。**

请在 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 数组中，**逐一加入以下精确规则**：

```json
"permissions.allow": [
  "mcp(promptcut/get_editor_state)",
  "mcp(promptcut/list_effects)",
  "mcp(promptcut/get_card)",
  "mcp(promptcut/add_card)",
  "mcp(promptcut/update_card)",
  "mcp(promptcut/remove_card)",
  "mcp(promptcut/import_srt)",
  "mcp(promptcut/import_video)",
  "mcp(promptcut/seek)",
  "mcp(promptcut/set_playing)",
  "mcp(promptcut/create_preset)",
  "mcp(promptcut/remove_preset)",
  "mcp(promptcut/transcribe_video)",
  "mcp(promptcut/probe_media)",
  "mcp(promptcut/get_card_authoring_guide)"
]
```

**安全提醒：** 不要使用通配符，绝对不要用 `--dangerously-skip-permissions`。上述精确规则仅授权我们当前自己的这个 MCP 服务，安全可控。

---

## 运行冒烟测试

执行以下命令跑测试：
```bash
node server/test/runner-smoke.mjs <provider> [--no-resume] [--no-abort] [--no-text] [--only-list]
```
`provider` 可选 `claude` / `agy` / `codex`。

**可用环境变量:**
- `PROMPTCUT_SMOKE_MCP` = (可选) 真 MCP 服务器的脚本路径（默认为用于测试的 dummy 脚本）
- `PROMPTCUT_RUNNER_DEBUG` = 1 (把每个工具传来的事件原始 JSON 流印出)

测试成功输出样例：
```
=== PASS/FAIL ===
session     : PASS
text        : PASS
tool_call   : PASS
tool_result : PASS
done        : PASS
resume      : PASS
abort       : PASS
```

---

## 安全红线遵守

所有运行器均已满足安全红线标准：
- **不使用任何高危参数** (`--dangerously-skip-permissions` 等全系禁用)。
- **隔离度高**：Claude 使用严格 MCP 配置隔离；Codex 明确 `read-only` 沙箱；Agy 要求精确绑定到单一动作的权限配置规则，不使用通配。

## 当前环境实测结论（2026-09-06）

| provider | 冒烟结果 | 说明 |
|:---|:---|:---|
| agy | 7/7 PASS | 需要先加 mcp(promptcut/*) 精确规则（见上文），加完 tool_call/tool_result/text/done/resume/abort 全通过；abort 实测 1020ms |
| claude | session/status/error 通过，tool_* 与 done 未通过 | CLI 端 OAuth 过期，用户需手动 `claude` 登录后复测；运行器代码本身已验证可正确 spawn、解析 NDJSON、报出真实错误 |
| codex | 仅 status/error 通过 | 进程在加载 ~/.codex/config.toml 时即失败（该版本不认某个取值），且第三方 provider 返回 403 账号已转移；两者都需用户侧处理 |

此外：
- `listProviders()` 探测显示，三家均 available:true 且带版本号（claude 2.1.221 / agy 1.1.27 / codex-cli 0.136.0）。
- agy 的多模态实测结论：`agy -p "@<视频绝对路径> …"` 可以直接听懂视频音频，能给出内容概括，也能直接产出带时间码的 SRT（时间码颗粒度较粗，约 2–4 秒一条），因此在本机没有 whisper 时可作为「视频→字幕」的备选路径。

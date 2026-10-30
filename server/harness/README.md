# Harness (API 直连)

这部分实现了与大模型 API 直接交互的 Harness，允许直接通过 API 驱动 Agent，而不依赖外部 CLI 工具。

## 1. 结构
- `agent.mjs`: Agent 类，负责工具调用的并行执行与重试循环，统筹 provider、tools 和 history。
- `history.mjs`: MessageHistory 类，管理消息数组，并在超过 Token 上限时按需安全截断。
- `schema.mjs`: 工具 Schema 清洗，转换内部的 `inputSchema` 为各家 API 原生兼容的 JSON Schema。
- `providers/base.mjs`: 接口契约，包含流数据增量解码 (`readSse`) 和通用 HTTP 断言 (`assertOk`)。
- `providers/mock.mjs`: 测试桩，模拟固定对话闭环。
- `providers/anthropic.mjs`: 支持 Anthropic Messages API 协议及 SSE 数据块拼装。
- `providers/openai.mjs`: 支持 OpenAI 兼容端点的 Chat Completions 流响应及 Tool Call 分片组装。
- `providers/gemini.mjs`: 支持 Gemini 的 StreamGenerateContent 及内部 Parts 组装转换。
- `tools/index.mjs`: 负责封装 mcp-tools 与内置工具，暴露统一 `execute` 执行切面。
- `tools/think.mjs`: 思考辅助工具。
- `tools/textEditor.mjs`: 基于工作区的文本编辑器。
- `tool-protocol.mjs`: 提供文本协议的 fallback 机制，供三大 CLI 运行器在原生 MCP 被拒时或强制模式下使用。导出的函数包括：
  - `parseToolBlocks(text)`: 解析出带 ````promptcut-tool```` 围栏的 JSON 工具调用，捕捉坏 JSON 并报错。
  - `hasToolBlocks(text)`: 判断文本中是否包含围栏。
  - `executeToolBlocks(blocks, callTool)`: 执行解析出的工具列表，返回带 ok、summary、files 等结果的数组。
  - `formatResultsAsUserMessage(results)`: 将执行结果组装为供下轮使用的 User Message。
  - `renderProtocolPrompt()`: 渲染注入给模型的文本协议提示，并拼接好所有可用工具的 Schema。
  - `runTextProtocolLoop({ startRun, opts, onEvent })`: 核心循环逻辑。返回**同步的** `{ abort, done }` 对象（`done` 是内部 loop 的 Promise）。契约包括：内层每轮的 done 事件会被拦截不往外发；整个循环结束时只发一条总的 done 事件；最多执行 8 轮上限，超过则强行停止并发送文本提示。

## 2. 与 claude-quickstarts/agents(Python) 的对应关系
- `agent.py` 对应这里的 `agent.mjs`。
- `tools/base.py` 的 Tool 基类对应我们统一的 `{ name, description, inputSchema, execute }` 对象形状。
- `utils/history_util.py` 对应 `history.mjs`。
- `utils/connections.py` (MCP 连接) 在此处被 `tools/index.mjs` 的 `callTool` 接缝取代。因为此项目的工具执行直接转交给已有的 `/api/mcp/call`，Harness 本身不需要维护底层 MCP 进程读写。

之所以使用 Node 零依赖实现，是因为编辑台（Vite、桌面端 Sidecar）完全是基于 Node 运行环境打包执行的。引入 Python 意味着增加运行时的打包与依赖成本。通过原生 ESM 进行移植，确保了高度的集成度及失败安全性，避免污染 `package.json`。

## 3. 为什么 str_replace_editor 要适配
在 Anthropic 原始接口中，`text_editor` 是服务端预先定义的内置工具类型 (`type` 形如 `text_editor_20250124`，`name` 为 `str_replace_editor`)，它的 Schema 仅在 API 侧且由系统自带。除了 Claude 以外，别家模型（如 OpenAI、Gemini）一概不认识该内置类型。
因此，我们把它显式降级为一个带完整 JSON Schema 的普通 function 工具，更名为 `text_editor`。保留了与 Anthropic 文档完全兼容的语义 (view/create/str_replace/insert/undo_edit)，从而实现多厂商通用。同时增加了强沙箱防范，确保所有路径变动严密锁定在 `workspaceDir` 内，超出越界一律拒绝。

## 4. 如何接一个新厂商
1. **新建 Provider**：在 `providers/<vendor>.mjs` 下新建模块，暴露 `createProvider(cfg, { fetchImpl })`。
2. **声明转换**：在 `schema.mjs` 的 `toolToVendor` 与 `sanitizeSchema` 补入相应的分支规则。
3. **分配 Provider**：在 `runners/api.mjs` 的 vendor 映射分发块 (`cfg.vendor`) 中添加对应入口加载。
4. **添加配置选项**：在 `ai-config.mjs` (Q1模块) 的 vendor 白名单中加入该枚举，供前端选择。

Provider 返回的 `stream` 异步迭代器需严格产出以下统一格式事件：
- `{ type: "text_delta", text }`
- `{ type: "tool_use", id, name, input }`
- `{ type: "usage", input, output }`
- `{ type: "stop", reason }`

<small>注意：真实 API Key 仅在内存里读取并填充至 HTTP Header，绝对不输出、拼接至日志、事件响应、或向历史缓存文件存盘。响应报错拦截也经过封装过滤，只截取服务端返回响应体的 `message` 字段前 300 字符。</small>

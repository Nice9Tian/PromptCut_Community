# MCP Editor API (`src/mcp`)

**最后重构日期：** 2026-09-19

## 重构说明 (Refactoring Note)
如果你是之前的维护者，你会发现原本巨大的 `src/editor/right/index.tsx` 被大幅度精简了。
过去，超过 100 个供 MCP Server 调用的 `EditorApi` 工具逻辑被硬编码在 `RightPanel` 的 `useEffect` 中，这导致该文件极度臃肿（超过 125KB），极大地增加了 AI 辅助编程时的 Token 消耗。

因此，我们进行了**彻底的架构解耦**：
1. **解耦 UI 与 AI API：** 所有的 MCP 工具实现逻辑都被抽离到了当前的 `src/mcp/` 目录下。
2. **状态与帮助函数提取：** 工具所依赖的闭包状态（如 `sttJobs`, `cardScopes`）和通用帮助函数被提取到了 `common.ts`。
3. **领域化打散：** 105 个庞大的工具对象被切分为 13 个独立的文件（位于 `handlers/` 目录下）。

## 文件结构

- **`routes.mjs` / `routes.d.mts`**: 工具名 → `EditorApi` 方法名的路由表。`src/ai/mcpExecutor.ts` 查这张表分发,
  不再是一百多个 `else if (tool === "xxx")`。写成纯数据的 `.mjs` 是为了让 `server/test/mcp-routes.test.mjs`
  能直接 import 它、拿 `server/mcp-tools.mjs` 对账 —— 工具表和路由表对不上当场测试失败。
  表外的特殊分支(公告板、`see_frames`、`get_gif`、`web_*`)列在同文件的 `SPECIAL_TOOLS` 里,附了留在表外的原因。
- **`tools/*.ts`**: 只服务 MCP 工具、不含任何 React / DOM 的纯逻辑模块,从 `src/editor/right/` 下沉过来:
  `toolEcho`(时间轴工具的回显与删除门槛)、`trackTools`(序列工具的校验和门槛)、`pixelMapTools`、
  `autoWorkflow`。`filterTools` / `audioFxTools` 没跟过来 —— 编辑台左栏的 `ClipFilterForm` /
  `ClipAudioFxForm` / 素材库分组也在用它们,搬过来只是把依赖方向掉个头。它们仍从这里引 `toolEcho`。
- **`api.ts`**: 聚合层。它导入 `handlers/` 下的所有子模块，拼装成完整的 `editorApi` 对象。UI 层的 `index.tsx` 只需 `import { editorApi } from "../../mcp/api"` 并将其挂载。
- **`common.ts`**: 原本在 `index.tsx` 里的所有纯函数、状态变量及外部 import。各个 handler 都从这里引入公用依赖。
- **`handlers/*.ts`**: 具体工具分类实现。例如 `vision.ts` 处理看图和排版，`audio.ts` 处理声音相关逻辑。若你需要新增或修改某个 MCP 工具，只需在对应的 handler 文件里修改即可，不再需要阅读几千行的无关代码。

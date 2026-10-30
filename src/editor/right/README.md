# Right Panel (`src/editor/right`)

**最后重构日期：** 2026-09-19

## 重构说明 (Refactoring Note)
**如果你是接手的开发者，请注意重大架构变更！**

过去，`index.tsx` 文件不仅包含 UI 组件（如 `RightPanel`、`DockHost` 等），还内置了所有供 AI (MCP) 调用的 `EditorApi` 工具列表。由于工具数量多达 100+ 个，文件体积超过 125KB，每次修改任何代码都极为消耗 AI Context Token。

为了解决严重的模块耦合问题，我们已经**移除了此文件中的所有 MCP 逻辑**：
- 现在的 `index.tsx` 只有不到 `12KB`，仅负责纯前端的视图挂载和组件生命周期。
- 所有的 MCP 工具实现都被抽离、打散并转移到了根目录下的 [`src/mcp/`](../../mcp/) 目录中。
- `RightPanel` 现在仅通过 `import { editorApi } from "../../mcp/api"` 引入拼装好的接口对象，并通过 `connectMcpExecutor` 进行挂载。

如果你需要**修改或添加给 AI 用的工具代码**，请移步至 `src/mcp/handlers/`。
如果你需要**修改右侧边栏的 UI**，请继续在此处操作。

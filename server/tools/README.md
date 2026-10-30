# MCP Server Tools (`server/tools`)

**最后重构日期：** 2026-09-19

## 重构说明 (Refactoring Note)
致之前接手该项目的后端开发者：
以前的 `server/mcp-tools.mjs` 是一个高达 109KB 的怪物，硬编码了一个包含 119 个长段 JSON Schema 的数组。一旦需要给 AI 添加、删减或修改工具提示词，都必须在这个巨大的数组里人肉搜寻，非常容易产生代码合并冲突和上下文迷失。

**本次重构：**
1. 我们按功能领域（例如浏览器控制、音频处理、素材效果卡排版）将其拆分到了 `server/tools/` 目录下的 15 个细分文件里。
2. 根目录的 `server/mcp-tools.mjs` 退化为了聚合导出层（将所有细分数组展开并重组）。
这样修改不会破坏原本后端的集成（依然暴露 `export const tools = [...]`），同时开发新工具也会更加高效。

## 文件结构

- **`../mcp-tools.mjs`**: The aggregate Facade file. It simply imports all the arrays from the modules below and exports a single combined `tools` array for the MCP Server runtime.
- **Submodules (`*.mjs`)**:
  - `agent.mjs`: Multi-agent communication (`declare_scope`, `send_message`, etc.)
  - `ai.mjs`: High-level AI features (Object tracking, Shots, STT, Auto-workflows)
  - `audio.mjs`: Audio leveling, voice generation, and audio FX
  - `browser.mjs`: Headless browser automation (`web_open`, `web_click`, etc.)
  - `cards.mjs`: Card ecosystem manipulation (baking, inspecting)
  - `clips.mjs`: Core timeline clip mutations
  - `collect.mjs`: Web media scraping and downloading
  - `core.mjs`: System lifecycle and playback (`wait`, `report_progress`, `user_interface_play`, `user_interface_seek`)
  - `ui-names.mjs`: 会动用户界面的工具改名对照(旧名 → `user_interface_` 新名,2026-10-21 用户定)。模型看到的是新名;工具入口新旧都认;发给页面的内部操作名保持旧名
  - `cuts.mjs`: Sub-clip stripping and transitions
  - `effects.mjs`: Visual filters and pixel maps
  - `layout.mjs`: Stage positioning, nudging, aligning, and 3D camera
  - `parts.mjs`: Composite card part management
  - `project.mjs`: Global project properties and theme
  - `tracks.mjs`: Track structures
  - `vision.mjs`: Server-side visual frame fetching (`see_frames`)

# Project Store (`src/store`)

**最后重构日期：** 2026-09-19

## 重构说明 (Refactoring Note)
致之前接手或维护该项目的开发者：
以前的架构中，`src/store/project.ts` 是一座“超级巨石”。它将状态订阅、历史撤销记录以及多达 72 个极其繁杂的 Action (如 `addClip`, `addTrack`, `applyAudioFx` 等) 全部硬编码在一个 57KB 大小的文件里。
这导致只要涉及任何业务变更，都必须在这个中心节点修改，使 AI 阅读代码时极其浪费 Token 并容易引起冲突。

**本次重构我们彻底解耦了这里：**
我们将原本在 `actions = { ... }` 里的方法拆分到了 `actions/` 子目录下的各个细分领域文件里，而底层订阅机制则提取到了 `core.ts` 里。
**对于上层 UI：** 你**完全不需要**修改现有任何组件的 `import` 路径！`project.ts` 如今作为一个 Facade（聚合出口），原样把所有分散的 actions 又合并了起来。

## 文件结构

- **`core.ts`**: Contains the `useSyncExternalStore` integration, the underlying `EditorState`, and the raw `setProject` / `set` mutation primitives. All UI components use the `useStore` hook from this file (re-exported via `project.ts`).
- **`project.ts`**: The aggregate Facade file. It merges all sub-module actions and `core` functions so external components can continue importing from `src/store/project.ts` without breaking changes.
- **`actions/*.ts`**: Contains the 72+ specific state actions, cleanly grouped by business logic:
  - `coreActions.ts`: History (`undo`/`redo`) and file I/O states (`loadProject`, `markSaved`).
  - `projectMeta.ts`: Global project settings and metadata.
  - `playback.ts`: Playhead state, play/pause controls, ticking.
  - `tracks.ts`: Track addition, removal, and ordering.
  - `clips.ts`: Clip CRUD operations.
  - `media.ts`: Media library management (adding files, linking transcripts/subjects).
  - `effects.ts`: Filters, Pixel maps, Transitions, and Crossfades.
  - `audio.ts`: Audio leveling, FX, and separation.
  - `captions.ts`: Subtitles and caption tracks.
  - `cuts.ts`: Jump cuts and strip logic.
  - `properties.ts`: Fine-grained clip properties (Layout, Motion, Parts).

import type { Clip } from "../kernel/types";

/**
 * 新项目塞的演示片段(`Editor.tsx`)。**纯数据,不 import 任何卡片模块**:
 * 编辑器页面从这里取,改一张卡的热更新就不会顺着「卡片 → native/index.ts → Editor.tsx」冒到编辑器上
 * (那会让 Editor、Preview 的 effect 在 Fast Refresh 里重跑,把舞台的 RPC 客户端清掉;C6.6 集成 3b)。
 * `cards/native`、`cards/magicui` 仍按原名转出这两份。
 */
export const magicuiDemoClips: Clip[] = [
  { id: "mu-1", cardId: "mu-number-ticker", start: 0, end: 2, params: {} },
  { id: "mu-2", cardId: "mu-blur-fade", start: 2, end: 4, params: {} },
  { id: "mu-3", cardId: "mu-circular-progress", start: 4, end: 6, params: {} },
  { id: "mu-4", cardId: "mu-typing", start: 6, end: 8, params: {} },
  { id: "mu-5", cardId: "mu-word-rotate", start: 8, end: 10, params: {} },
];

export const nativeDemoClips: Clip[] = [
  { id: "n1", cardId: "odometer", start: 10, end: 12, params: {} },
  { id: "n2", cardId: "blur-text", start: 12, end: 14, params: {} },
  { id: "n3", cardId: "ring-metric", start: 14, end: 16, params: {} },
  { id: "n4", cardId: "checklist", start: 16, end: 18, params: {} },
  { id: "n5", cardId: "step-timeline", start: 18, end: 20, params: {} }
];

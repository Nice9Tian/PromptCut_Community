import type { Clip } from "../kernel/types";

/**
 * The demo clips stuffed into a new project (`Editor.tsx`). **Pure data, importing no card module**:
 * the editor page takes them from here, so hot updates of a card do not bubble up to the editor along
 * "card → native/index.ts → Editor.tsx" (that would make the effects of Editor and Preview rerun
 * during Fast Refresh and clear the stage's RPC client; C6.6 integration 3b).
 * `cards/native` and `cards/magicui` still re-export these two under their original names.
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

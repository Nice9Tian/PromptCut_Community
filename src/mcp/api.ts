import type { EditorApi } from "../ai/mcpExecutor";
import { visionHandlers } from "./handlers/vision";
import { projectHandlers } from "./handlers/project";
import { clipsHandlers } from "./handlers/clips";
import { cutSegmentHandlers } from "./handlers/cutSegments";
import { layoutHandlers } from "./handlers/layout";
import { partsHandlers } from "./handlers/parts";
import { tracksHandlers } from "./handlers/tracks";
import { effectsHandlers } from "./handlers/effects";
import { audioHandlers } from "./handlers/audio";
import { cardAudioHandlers } from "./handlers/cardAudio";
import { cardsHandlers } from "./handlers/cards";
import { aiHandlers } from "./handlers/ai";
import { collectHandlers } from "./handlers/collect";
import { playbackHandlers } from "./handlers/playback";
import { systemHandlers } from "./handlers/system";

/*
 * Marked as pure calls: spread syntax (`{ ...a }`) is treated as having side effects during
 * tree shaking, so the entire copy would be retained even if unused. When the only consumer
 * in the online build (`editor/right/index.tsx` connecting to the tool runner) is pruned out,
 * marking as pure calls allows this table, along with the /api calls behind each handler,
 * to be pruned together (M8 legacy L24).
 */
export const editorApi: EditorApi = /* @__PURE__ */ Object.assign(
  {},
  visionHandlers,
  projectHandlers,
  clipsHandlers,
  cutSegmentHandlers,
  layoutHandlers,
  partsHandlers,
  tracksHandlers,
  effectsHandlers,
  audioHandlers,
  cardAudioHandlers,
  cardsHandlers,
  aiHandlers,
  collectHandlers,
  playbackHandlers,
  systemHandlers,
);

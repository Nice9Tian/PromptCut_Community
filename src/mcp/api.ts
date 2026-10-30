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
 * 标成纯调用:展开写法(`{ ...a }`)在摇树时算有副作用,没人用也会整份留下。在线构建里唯一的使用方
 * (`editor/right/index.tsx` 连工具执行器)被剪掉,标了纯调用这份表连同各 handler 背后的 /api 调用才一起剪掉(M8 遗留 L24)。
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

import type { CardDef, Clip } from "../../kernel/types";
import { chapterBar } from "./chapter-bar";
import { captionTrack } from "./caption-track";
import { terminal3d } from "./terminal-3d";
import { focusCard } from "./focus-card";

export const timelineCards: CardDef<any>[] = [chapterBar, captionTrack, terminal3d, focusCard];
export const timelineDemoClips: Clip[] = [
  { id: "chapter-bar-1", cardId: "chapter-bar", start: 42, end: 48, params: {} },
  { id: "caption-track-1", cardId: "caption-track", start: 48, end: 54, params: {} },
  { id: "terminal-3d-1", cardId: "terminal-3d", start: 54, end: 57, params: {} },
  { id: "focus-card-1", cardId: "focus-card", start: 57, end: 60, params: {} },
];

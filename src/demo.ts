import type { Timeline } from "./kernel/types";
import { magicuiDemoClips } from "./cards/magicui";
import { nativeDemoClips } from "./cards/native";
import { textDemoClips } from "./cards/native/batch-text";
import { dataDemoClips } from "./cards/native/batch-data";
import { timelineDemoClips } from "./cards/native/batch-timeline";

/**
 * Demo timeline: shared by preview and export.
 * 0–10 s Magic UI adapter cards, 10–20 s built-in Motion cards; the probe card and the first Magic
 * UI card are on screen together (0–2 s).
 */
export const demoTimeline: Timeline = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 60,
  clips: [
    { id: "probe", cardId: "probe", start: 0, end: 2, params: {} },
    ...magicuiDemoClips,
    ...nativeDemoClips,
    ...textDemoClips,
    ...dataDemoClips,
    ...timelineDemoClips,
  ],
};

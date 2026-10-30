import type { Timeline } from "./kernel/types";
import { magicuiDemoClips } from "./cards/magicui";
import { nativeDemoClips } from "./cards/native";
import { textDemoClips } from "./cards/native/batch-text";
import { dataDemoClips } from "./cards/native/batch-data";
import { timelineDemoClips } from "./cards/native/batch-timeline";

/**
 * 演示时间轴:预览和导出共用。
 * 0–10 秒 Magic UI 适配卡,10–20 秒自家 Motion 卡,探针卡和第一张 Magic UI 卡同屏(0–2 秒)。
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

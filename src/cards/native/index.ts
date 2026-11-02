import type { CardDef } from "../../kernel/types";
import { odometer } from "./odometer";
import { blurText } from "./blur-text";
import { ringMetric } from "./ring-metric";
import { checklist } from "./checklist";
import { stepTimeline } from "./step-timeline";
import { textCards } from "./batch-text";
import { dataCards } from "./batch-data";
import { timelineCards } from "./batch-timeline";
import { lottieCard } from "./lottie";
import { particlesCard } from "./particles";
import { scene3dCard } from "./scene-3d";
import { compositeCard } from "./composite";
import { audiovisualPulse } from "./av-pulse";
import { notificationSoundCard, keyboardSoundCard } from "./sound-effects";

/** In-house cards written with Motion. One file per card, collected here. */
export const nativeCards: CardDef<any>[] = [
  audiovisualPulse,
  notificationSoundCard,
  keyboardSoundCard,
  compositeCard,
  lottieCard,
  particlesCard,
  scene3dCard,
  odometer,
  blurText,
  ringMetric,
  checklist,
  stepTimeline,
  ...textCards,
  ...dataCards,
  ...timelineCards,
];

export { nativeDemoClips } from "../demoClips";

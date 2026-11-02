import type { CardDef } from "../../kernel/types";
// The animate-* animation classes used by MagicUI components (shiny-text / marquee / orbit …).
// They live in MagicUI's own Tailwind theme, which we do not have; importing them once here makes
// them available site-wide, and components imported by the translator do not need a single class
// name changed. See the explanation at the head of that file.
import "./vendor/magicui-animations.css";
import { numberTickerCard } from "./number-ticker.card";
import { blurFadeCard } from "./blur-fade.card";
import { animatedCircularProgressBarCard } from "./animated-circular-progress-bar.card";
import { typingAnimationCard } from "./typing-animation.card";
import { wordRotateCard } from "./word-rotate.card";

export const magicuiCards: CardDef<any>[] = [
  numberTickerCard,
  blurFadeCard,
  animatedCircularProgressBarCard,
  typingAnimationCard,
  wordRotateCard,
];

export { magicuiDemoClips } from "../demoClips";

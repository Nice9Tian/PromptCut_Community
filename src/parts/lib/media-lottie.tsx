import type { PartDef, PartProps } from "../../kernel/partTypes";
import { LottieView } from "../../cards/native/lottie";
import { assetOptions } from "../../cards/catalogAssets";

/**
 * Lottie animation.
 * Media part extracted from lottie card, positioned frame by frame according to timeline.
 * Entrance: follows timeline, displays upon mount, and does not rely on its own clock.
 */
interface Params {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
}

function MediaLottiePart({ params, t, width, height }: PartProps<Params>) {
  return (
    <div style={{ position: "absolute", inset: 0, width, height }}>
      <LottieView
        json={params.json}
        src={params.src}
        speed={params.speed}
        loop={params.loop}
        fit={params.fit}
        t={t}
      />
    </div>
  );
}

export const mediaLottie: PartDef<Params> = {
  id: "media-lottie",
  name: "Lottie animation",
  description: "Play a Lottie animation, advancing frame by frame with the timeline",
  useWhen: "Place a ready-made Lottie animation (JSON exported from AE). The 5 built-in assets are listed in the hint of src; you can also paste JSON text into json or enter another URL. It does not \"play\" by itself but is positioned frame by frame according to time; speed adjusts the pace and loop decides whether it loops at the end or stays on the last frame. Check the asset license yourself. Not suitable for drawing motion graphics from scratch.",
  tags: ["lottie", "animation file", "AE", "media"],
  role: "media",
  from: "lottie",
  defaults: {
    json: "",
    src: "/catalog/lottie/bodymovin.json",
    speed: 1,
    loop: "no",
    fit: "contain",
  },
  controls: [
    { key: "json", label: "Lottie JSON text (preferred)", type: "text", hint: "Contents of the whole .json file; leave empty to use src" },
    { key: "src", label: "Asset / URL", type: "asset", kind: "lottie", options: assetOptions("lottie"), hint: "Pick one from the asset catalog (a URL in options), or enter another JSON URL; it is only used when json is empty" },
    { key: "speed", label: "Speed multiplier", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "At the end", type: "select", options: [{ value: "no", label: "Hold last frame" }, { value: "yes", label: "Loop" }] },
    { key: "fit", label: "Fit", type: "select", options: [{ value: "contain", label: "Show in full" }, { value: "cover", label: "Fill and crop" }] },
  ],
  defaultFrame: { x: 960, y: 540, w: 600, h: 600, anchor: [0.5, 0.5] },
  settleMs: () => 0,
  after: "evolve",
  Component: MediaLottiePart,
};

import { useMemo } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, accentOf } from "./hud";
import "./hud.css";
import { compileCaptionFrames, captionFrameAt } from "../../render/captionFrame.mjs";

interface Params extends HudParams {
  lines: string;
  showEn: string;
  strokeOn: string;
  strokeW: number;
  strokeColor: string;
}

function genTextShadow(w: number, color: string) {
  let shadow = [];
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * w * 10) / 10;
    const y = Math.round(Math.sin(angle) * w * 10) / 10;
    shadow.push(`${x}px ${y}px 0 ${color}`);
  }
  return shadow.join(", ");
}

function CaptionTrackCard({ params, t = 0 }: CardProps<Params>) {
  const compiled = useMemo(() => compileCaptionFrames(params.lines), [params.lines]);
  const frame = captionFrameAt(compiled, t);
  const curLine = frame?.line;

  if (!curLine) {
    return <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }} />;
  }

  const zhParts = curLine.zh.split("*");
  const strokeStyle = params.strokeOn === "true" ? { textShadow: genTextShadow(params.strokeW, params.strokeColor) } : {};

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }}>
        <div
          key={frame!.index}
          style={{ opacity: frame!.opacity, transform: frame!.y === 0 ? "none" : `translateY(${frame!.y}px)` }}
          className="flex flex-col items-center"
        >
          <div className="text-[56px] text-white text-center font-bold tracking-wide" style={strokeStyle}>
            {zhParts.map((part, i) => {
              if (i % 2 === 1) {
                return (
                  <span key={i} style={{ color: accentOf(params) }}>
                    {part}
                  </span>
                );
              }
              return <span key={i}>{part}</span>;
            })}
          </div>
          {params.showEn === "true" && curLine.en && (
            <div className="text-[32px] text-[#a0aab4] text-center mt-4">
              {curLine.en}
            </div>
          )}
        </div>
    </div>
  );
}

export const captionTrack: CardDef<Params> = {
  id: "caption-track",
  name: "Persistent bilingual captions",
  description: "Shows bilingual captions based on time",
  source: "native",
  useWhen: "Lays persistent captions over a whole narration. One card covering the whole time range is enough; do not create one per sentence. lines is required; usually fill it directly from the transcript with fill_captions.",
  tags: ["Captions", "caption", "subtitle", "transcription", "bilingual"],
  defaults: {
    ...hudDefaults,
    position: "bottom",
    // Empty by default: caption content can only come from the transcript, so no meaningful default
    // can be given.
    // This used to hold three lines of demo text, which would play as is when lines was missing, looking
    // like "captions added" while actually showing sample text unrelated to the video: the failure was
    // covered up by the default. Now when it is missing it is simply empty, and lines is marked
    // required, so it is blocked at card creation.
    lines: "",
    showEn: "true",
    strokeOn: "true",
    strokeW: 4,
    strokeColor: "#000000",
  },
  controls: [
    // The component hardcodes alignItems: flex-end and paddingBottom inline, so captions always stick to
    // the bottom. The generic hudControls "Position" has a "Center" option, but on this card it has no
    // effect vertically at all, and only the horizontal direction (left/right) changes. So the label and
    // options are replaced here with only the three that really take effect, so that a user who picks
    // "Center" does not think the captions will move to the middle of the picture, and the AI does not
    // fill it in that way either.
    {
      key: "position", label: "Horizontal position", type: "select",
      options: [
        { value: "bottom", label: "Bottom center" },
        { value: "left", label: "Bottom left" },
        { value: "right", label: "Bottom right" },
      ],
    },
    ...hudControls.filter((c) => c.key !== "position"),
    {
      key: "lines", label: "Captions (start|end|Chinese|English)", type: "text", required: true,
      hint: "One caption per line, in the format `start|end|Chinese|English` (English may be left empty); seconds are relative to this clip's start. In the Chinese text, words wrapped in *asterisks* are highlighted in the main color. You can use fill_captions to fill them automatically from the media transcript.",
    },
    { key: "showEn", label: "Show English", type: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }] },
    { key: "strokeOn", label: "Enable stroke", type: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }] },
    { key: "strokeW", label: "Stroke width", type: "number" },
    { key: "strokeColor", label: "Stroke color", type: "color" },
  ],
  parts: [
    { id: "lines", label: "Caption lines", role: "list", params: ["lines", "showEn", "strokeOn", "strokeW", "strokeColor"] },
  ],
  lifecycle: { after: "evolve", exit: ["fade"] },
  frameMode: "direct",
  Component: CaptionTrackCard,
};

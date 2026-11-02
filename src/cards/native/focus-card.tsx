import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { isExportMode } from "../../kernel/clock";
import { HudParams, hudControls, hudDefaults, easeExpoOut, accentOf } from "./hud";

interface Params extends HudParams {
  bg: string;
  side: string;
  items: string;
  stepMs: number;
  camSrc: string;
  showRing: string;
  camDX: number;
  camDY: number;
  camW: number;
  camH: number;
}

function FocusCard({ params, t = 0 }: CardProps<Params>) {
  const bgColors: Record<string, string> = {
    cream: "#fdfbf7",
    mist: "#f0f2f5",
    dark: "#0c0e14",
  };
  const bgColor = bgColors[params.bg] || bgColors.dark;

  const items = params.items.split("|").filter(Boolean);
  const isLeft = params.side === "left";

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-auto" style={{ zIndex: 100 }}>
      {/* Background */}
      <motion.div
        className="absolute inset-0"
        style={{ backgroundColor: bgColor }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: easeExpoOut }}
      />

      {/* Content wrapper */}
      <div
        className="relative w-full h-full max-w-[1920px] max-h-[1080px] flex items-center"
        style={{ flexDirection: isLeft ? "row" : "row-reverse", padding: "0 160px", gap: "120px" }}
      >
        {/* Cam Container */}
        <div className="relative flex-shrink-0" style={{ transform: `translate(${params.camDX}px, ${params.camDY}px)` }}>
          <motion.div
            className="overflow-hidden relative"
            style={{
              width: params.camW,
              height: params.camH,
              borderRadius: "48px",
              boxShadow: "0 40px 80px rgba(0,0,0,0.3)",
            }}
            initial={{ scale: 1.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: easeExpoOut }}
          >
            {params.showRing === "true" && (
              <div
                className="absolute inset-0 z-20 pointer-events-none"
                style={{
                  border: `4px solid ${accentOf(params)}`,
                  borderRadius: "48px",
                }}
              />
            )}
            {params.camSrc ? (
              <video
                src={isExportMode() ? undefined : params.camSrc}
                data-pc-media-src={isExportMode() ? params.camSrc : undefined}
                data-pc-media-time={Math.max(0, t)}
                preload={isExportMode() ? "none" : "auto"}
                style={isExportMode() ? { visibility: "hidden" } : undefined}
                muted
                playsInline
                autoPlay={!isExportMode()}
                loop
                className="w-full h-full object-cover relative z-10"
              />
            ) : (
              <div
                className="w-full h-full relative z-10 flex items-center justify-center text-[48px] font-bold text-white"
                style={{ background: `linear-gradient(135deg, ${accentOf(params)}, #222)` }}
              >
                口播视频
              </div>
            )}
          </motion.div>
        </div>

        {/* Text items */}
        <div className="flex flex-col gap-10 flex-1">
          {items.map((item, i) => (
            <motion.div
              key={i}
              className="flex items-center gap-8"
              initial={{ opacity: 0, x: isLeft ? 40 : -40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.6, delay: i * (params.stepMs / 1000) + 0.3, ease: easeExpoOut }}
            >
              <div
                className="rounded-full flex-shrink-0"
                style={{ width: "48px", height: "16px", backgroundColor: accentOf(params) }}
              />
              <div className="text-[64px] font-bold" style={{ color: "#ffffff" }}>
                {item}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const focusCard: CardDef<Params> = {
  id: "focus-card",
  name: "Person focus",
  description: "Half-screen narration, half-screen key points",
  useWhen: "Full-screen layout for a person presenting on camera: the opaque solid background fully covers the underlying picture, 16:9 landscape only. You must provide a separate narration video URL camSrc, otherwise that half of the screen is just a placeholder block reading \"narration video\"; the other side holds 2 to 3 key points. The key point text is fixed white, so bg must be a dark color. If you only want to overlay key points on the original video, use pin-board or checklist instead.",
  tags: ["person","half-screen","on camera","Key points"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    bg: "dark",
    side: "left",
    items: "选题决定上限，方向比努力重要|脚本钩子在前三秒，留住就赢了|剪辑节奏控完播，一帧都不能浪费",
    stepMs: 300,
    camSrc: "",
    showRing: "true",
    camDX: 0,
    camDY: 0,
    camW: 720,
    camH: 960,
  },
  controls: [
    ...hudControls,
    { key: "bg", label: "background", type: "select", options: [{ value: "cream", label: "Cream" }, { value: "mist", label: "Mist white" }, { value: "dark", label: "Dark" }] },
    { key: "side", label: "Narration position", type: "select", options: [{ value: "left", label: "Left" }, { value: "right", label: "Right" }] },
    { key: "items", label: "Key points (| separated)", type: "text" },
    { key: "stepMs", label: "Pop-in interval ms", type: "number" },
    { key: "camSrc", label: "Video URL", type: "text" },
    { key: "showRing", label: "Show outer ring", type: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }] },
    { key: "camDX", label: "Video X offset", type: "number" },
    { key: "camDY", label: "Video Y offset", type: "number" },
    { key: "camW", label: "Video width", type: "number" },
    { key: "camH", label: "Video height", type: "number" },
  ],
  parts: [
    { id: "bg", label: "background", role: "decor", params: ["bg"], enterMs: 0, settleMs: 500 },
    { id: "cam", label: "Narration video", role: "media", params: ["camSrc", "showRing", "camDX", "camDY", "camW", "camH", "side"], enterMs: 0, settleMs: 700 },
    { id: "items", label: "Key points", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 300 + 2 * 300 + 600 },
  ],
  lifecycle: { settleMs: 1500, after: "evolve", exit: ["fade"] },
  Component: FocusCard,
};

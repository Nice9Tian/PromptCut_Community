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
  name: "人物聚焦",
  description: "半屏口播半屏要点",
  useWhen: "人物出镜讲解的全屏版式:不透明实色背景会完全盖住底层画面,仅限 16:9 横屏。必须给独立口播视频地址 camSrc,否则那半屏只是写着「口播视频」的占位块;另一侧放 2 到 3 条要点。要点文字固定白色,所以 bg 要用深色。只想在原视频上叠要点浮层,改用 pin-board 或 checklist。",
  tags: ["人物","半屏","出镜","要点"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
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
    { key: "bg", label: "背景", type: "select", options: [{ value: "cream", label: "米色" }, { value: "mist", label: "雾白" }, { value: "dark", label: "暗色" }] },
    { key: "side", label: "口播位置", type: "select", options: [{ value: "left", label: "左" }, { value: "right", label: "右" }] },
    { key: "items", label: "要点(|分隔)", type: "text" },
    { key: "stepMs", label: "弹入间隔ms", type: "number" },
    { key: "camSrc", label: "视频URL", type: "text" },
    { key: "showRing", label: "显示外环", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "camDX", label: "视频X偏移", type: "number" },
    { key: "camDY", label: "视频Y偏移", type: "number" },
    { key: "camW", label: "视频宽", type: "number" },
    { key: "camH", label: "视频高", type: "number" },
  ],
  parts: [
    { id: "bg", label: "背景", role: "decor", params: ["bg"], enterMs: 0, settleMs: 500 },
    { id: "cam", label: "口播视频", role: "media", params: ["camSrc", "showRing", "camDX", "camDY", "camW", "camH", "side"], enterMs: 0, settleMs: 700 },
    { id: "items", label: "要点", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 300 + 2 * 300 + 600 },
  ],
  lifecycle: { settleMs: 1500, after: "evolve", exit: ["fade"] },
  Component: FocusCard,
};

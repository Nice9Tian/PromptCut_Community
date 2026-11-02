import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import "../../cards/native/hud.css";
import { fitOr } from "../fit";

/**
 * A/B comparison panel.
 * Composite part extracted from versus-card. Contains left and right cards and a center VS badge.
 * Entrance: cards on both sides slide in from outside inward (0.5s), then center badge springs into
 * view (delay 0.3s + 0.6s). Can highlight winner and dim the other side.
 */
interface Params {
  aKicker: string;
  aTitle: string;
  aSub: string;
  aAccent: string;
  bKicker: string;
  bTitle: string;
  bSub: string;
  winner: string;
  accent: string;
  size: number;
}

function GroupVersusPart({ params, width, height }: PartProps<Params>) {
  const winner = params.winner;
  const isAWinner = winner === "a";
  const isBWinner = winner === "b";
  const dimOpacity = 0.5;

  const aColor = params.aAccent && params.aAccent.trim() ? params.aAccent : accentOf(params);
  const bColor = accentOf(params);

  const longerTitle = (params.aTitle?.length || 0) > (params.bTitle?.length || 0) ? params.aTitle : params.bTitle;
  const size = fitOr(params.size, { width: (width - 112) / 2 * 0.75, height: height - 128, text: longerTitle, lines: 2.2, max: 120 });

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", width, height }}>
      <div className="flex items-center justify-center gap-12 relative w-full h-full p-8">
        {/* Card A */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center justify-center gap-4 py-16 h-full"
          initial={{ opacity: 0, x: -100 }}
          animate={{ opacity: isBWinner ? dimOpacity : 1, x: 0, scale: isAWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isAWinner ? aColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isAWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="tracking-widest opacity-80 uppercase font-mono" style={{ fontSize: size * 0.28 }}>{params.aKicker}</div>
          <div className="font-bold leading-tight my-2" style={{ fontSize: size }}>{params.aTitle}</div>
          <div className="opacity-60" style={{ fontSize: size * 0.33 }}>{params.aSub}</div>
        </motion.div>

        {/* VS Badge */}
        <motion.div
          className="absolute left-1/2 top-1/2 rounded-full bg-black/60 border border-white/20 flex items-center justify-center font-bold font-mono italic z-10 backdrop-blur-md"
          initial={{ opacity: 0, scale: 0, x: "-50%", y: "-50%" }}
          animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
          transition={{ duration: 0.6, delay: 0.3, type: "spring", bounce: 0.5 }}
          style={{ width: size * 1.56, height: size * 1.56, fontSize: size * 0.5 }}
        >
          VS
        </motion.div>

        {/* Card B */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center justify-center gap-4 py-16 h-full"
          initial={{ opacity: 0, x: 100 }}
          animate={{ opacity: isAWinner ? dimOpacity : 1, x: 0, scale: isBWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isBWinner ? bColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isBWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="tracking-widest opacity-80 uppercase font-mono" style={{ fontSize: size * 0.28 }}>{params.bKicker}</div>
          <div className="font-bold leading-tight my-2" style={{ fontSize: size }}>{params.bTitle}</div>
          <div className="opacity-60" style={{ fontSize: size * 0.33 }}>{params.bSub}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const groupVersus: PartDef<Params> = {
  id: "group-versus",
  name: "Versus card",
  description: "Side-by-side comparison panel, can highlight the winner",
  useWhen: "Use to contrast two options / two routes (\"compared to\", \"instead of\", \"the difference is\", \"vs\"); the winning side can be highlighted. Use chart-rank to compare 3 or more items and metric-stat for a single number.",
  tags: ["comparison","versus","side by side","contrast"],
  role: "group",
  from: "versus-card",
  defaults: {
    aKicker: "OPTION A",
    aTitle: "传统方案",
    aSub: "开发成本高，周期长",
    aAccent: "",
    bKicker: "OPTION B",
    bTitle: "我们的方案",
    bSub: "开箱即用，降本增效",
    winner: "b",
    accent: "",
    size: 0,
  },
  controls: [
    { key: "aKicker", label: "Side A kicker", type: "text" },
    { key: "aTitle", label: "Side A title", type: "text" },
    { key: "aSub", label: "Side A description", type: "text" },
    { key: "aAccent", label: "Side A accent color", type: "color" },
    { key: "bKicker", label: "Side B kicker", type: "text" },
    { key: "bTitle", label: "Side B title", type: "text" },
    { key: "bSub", label: "Side B description", type: "text" },
    {
      key: "winner",
      label: "Winner",
      type: "select",
      options: [
        { value: "none", label: "none" },
        { value: "a", label: "A wins" },
        { value: "b", label: "B wins" },
      ],
    },
    { key: "accent", label: "Main color / side B color", type: "color" },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 200, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1200, h: 600, anchor: [0.5, 0.5] },
  settleMs: () => 900,
  after: "hold",
  Component: GroupVersusPart,
};

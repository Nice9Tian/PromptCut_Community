import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  aKicker: string;
  aTitle: string;
  aSub: string;
  aAccent: string;
  bKicker: string;
  bTitle: string;
  bSub: string;
  winner: "a" | "b" | "none";
}

function VersusCard({ params }: CardProps<Params>) {
  const winner = params.winner;
  const isAWinner = winner === "a";
  const isBWinner = winner === "b";
  const dimOpacity = 0.5;

  const aColor = params.aAccent && params.aAccent.trim() ? params.aAccent : accentOf(params);
  const bColor = accentOf(params);

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="flex items-center justify-center gap-12 relative w-[1200px]">
        {/* Card A */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center gap-4 py-16"
          initial={{ opacity: 0, x: -100 }}
          animate={{ opacity: isBWinner ? dimOpacity : 1, x: 0, scale: isAWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isAWinner ? aColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isAWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="text-xl tracking-widest opacity-80 uppercase font-mono">{params.aKicker}</div>
          <div className="text-[72px] font-bold leading-tight my-2">{params.aTitle}</div>
          <div className="text-2xl opacity-60">{params.aSub}</div>
        </motion.div>

        {/* VS Badge */}
        <motion.div
          className="absolute left-1/2 top-1/2 w-28 h-28 rounded-full bg-black/60 border border-white/20 flex items-center justify-center text-4xl font-bold font-mono italic z-10 backdrop-blur-md"
          initial={{ opacity: 0, scale: 0, x: "-50%", y: "-50%" }}
          animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
          transition={{ duration: 0.6, delay: 0.3, type: "spring", bounce: 0.5 }}
        >
          VS
        </motion.div>

        {/* Card B */}
        <motion.div
          className="hud-glass flex-1 flex flex-col items-center text-center gap-4 py-16"
          initial={{ opacity: 0, x: 100 }}
          animate={{ opacity: isAWinner ? dimOpacity : 1, x: 0, scale: isBWinner ? 1.04 : 1 }}
          transition={{ duration: 0.5, ease: easeExpoOut }}
          style={{
            borderColor: isBWinner ? bColor : "var(--pc-glass-border, rgba(255,255,255,0.14))",
            borderWidth: isBWinner ? "2px" : "var(--pc-border-width, 1px)",
          }}
        >
          <div className="text-xl tracking-widest opacity-80 uppercase font-mono">{params.bKicker}</div>
          <div className="text-[72px] font-bold leading-tight my-2">{params.bTitle}</div>
          <div className="text-2xl opacity-60">{params.bSub}</div>
        </motion.div>
      </div>
    </div>
  );
}

export const versusCard: CardDef<Params> = {
  id: "versus-card",
  name: "Versus card",
  description: "Side-by-side comparison panel, can highlight the winner",
  useWhen: "When the narration makes a comparison (\"compared to\", \"rather than\", \"the difference is\", \"vs\"), use two side-by-side columns and optionally highlight the winning side.",
  tags: ["comparison","versus","side by side","contrast"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    aKicker: "OPTION A",
    aTitle: "传统方案",
    aSub: "开发成本高，周期长",
    aAccent: "",
    bKicker: "OPTION B",
    bTitle: "我们的方案",
    bSub: "开箱即用，降本增效",
    winner: "b",
  },
  controls: [
    ...hudControls,
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
  ],
  parts: [
    { id: "cardA", label: "Side A", role: "group", params: ["aKicker", "aTitle", "aSub", "aAccent"], enterMs: 0, settleMs: 500 },
    { id: "cardB", label: "Side B", role: "group", params: ["bKicker", "bTitle", "bSub"], enterMs: 0, settleMs: 500 },
    { id: "badge", label: "VS badge", role: "decor", params: ["winner"], enterMs: 300, settleMs: 900 },
  ],
  lifecycle: { settleMs: 900, after: "hold", exit: ["fade"] },
  Component: VersusCard,
};

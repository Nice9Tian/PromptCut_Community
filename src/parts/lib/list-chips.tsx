import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * Entity nameplates: extracted from entity-chips card.
 * Displays nameplate pills for people or institutions, without side notes.
 */
interface Params {
  chips: string;
  size: number;
  stepMs: number;
}

function ChipsPart({ params, width, height }: PartProps<Params>) {
  const chipLines = params.chips.split("\n").filter(Boolean);
  const fitText = chipLines.map((l) => l.split("|").slice(1).join("")).join("|");
  const size = fitOr(params.size, { width, height, text: fitText, splitter: "|", lineHeight: 2 + 16 / 28, max: 120 });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-start",
        gap: 16,
        boxSizing: "border-box",
      }}
    >
      {chipLines.map((line, i) => {
        const [style, name, title] = line.split("|");
        const isDark = style === "dark";
        return (
          <motion.div
            key={i}
            className="shadow-lg overflow-hidden whitespace-nowrap flex items-center"
            style={{
              backgroundColor: isDark ? "#111" : "#fff",
              color: isDark ? "#fff" : "#111",
              width: "fit-content",
              height: size * 2,
              borderRadius: size,
              padding: `0 ${size * (32 / 28)}px`,
              gap: size * (16 / 28),
            }}
            initial={{ opacity: 0, x: -60 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: (i * params.stepMs) / 1000, duration: 0.6, ease: easeExpoOut }}
          >
            <div className="font-bold" style={{ fontSize: size }}>{name}</div>
            {title && (
              <>
                <div className="w-[2px] bg-current opacity-20" style={{ height: size * (24 / 28) }} />
                <div className="opacity-80" style={{ fontSize: size * (24 / 28) }}>{title}</div>
              </>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

export const listChips: PartDef<Params> = {
  id: "list-chips",
  name: "Entity name tags",
  description: "List of name-tag pills for people or organizations, sliding in one by one",
  useWhen: "Use when introducing entity names such as team members, guests or partner organizations; black and white pills holding a name and title slide in one by one. Use list-pins for ordinary key-point lists and list-check for items with a tick state.",
  tags: ["name tag", "entity", "person", "organization"],
  role: "list",
  from: "entity-chips",
  defaults: {
    chips: "dark|张三|创始人\nlight|李四|技术总监",
    size: 0,
    stepMs: 150,
  },
  controls: [
    { key: "chips", label: "Name tags (style|name|title, newline-separated)", type: "text", required: true },
    { key: "size", label: "Font size (0 = auto-fit to box)", type: "number", min: 0, max: 120, step: 2, hint: "0 means auto-computed from the part's box; enter a pixel value to fix it" },
    { key: "stepMs", label: "Interval (ms)", type: "number", min: 0, max: 2000, step: 10 },
  ],
  defaultFrame: { x: 160, y: 360, w: 600, h: 360 },
  settleMs: (p) => (Math.max(1, p.chips.split("\n").filter(Boolean).length) - 1) * p.stepMs + 600,
  after: "hold",
  Component: ChipsPart,
};

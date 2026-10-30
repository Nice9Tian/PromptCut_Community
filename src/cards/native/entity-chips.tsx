import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, easeExpoOut, accentOf } from "./hud";
import "./hud.css";

interface Params extends HudParams {
  chips: string;
  note: string;
  stepMs: number;
}

function EntityChipsCard({ params }: CardProps<Params>) {
  const accent = accentOf(params);
  const chipLines = params.chips.split("\n").filter(Boolean);
  const noteLines = (params.note || "").split("|").filter(Boolean);
  
  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`}>
      <div className="flex items-center gap-12">
        <div className="flex flex-col gap-4">
          {chipLines.map((line, i) => {
            const [style, name, title] = line.split("|");
            const isDark = style === "dark";
            return (
              <motion.div
                key={i}
                className="h-[56px] rounded-[28px] px-8 flex items-center gap-4 shadow-lg overflow-hidden whitespace-nowrap"
                style={{ 
                  backgroundColor: isDark ? "#111" : "#fff",
                  color: isDark ? "#fff" : "#111",
                }}
                initial={{ opacity: 0, x: -60 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: (i * params.stepMs) / 1000, duration: 0.6, ease: easeExpoOut }}
              >
                <div className="text-[28px] font-bold">{name}</div>
                {title && (
                  <>
                    <div className="w-[2px] h-[24px] bg-current opacity-20" />
                    <div className="text-[24px] opacity-80">{title}</div>
                  </>
                )}
              </motion.div>
            );
          })}
        </div>
        {noteLines.length > 0 && (
          <motion.div 
            className="flex flex-col gap-1 border-l-2 pl-6"
            style={{ borderColor: accent }}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: (chipLines.length * params.stepMs + 200) / 1000, duration: 0.6, ease: easeExpoOut }}
          >
            {noteLines.map((nl, i) => (
              <div key={i} className="text-gray-400 text-[24px]">{nl}</div>
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}

export const entityChips: CardDef<Params> = {
  id: "entity-chips",
  name: "实体名牌",
  description: "展示人物或机构的名牌",
  useWhen: "介绍团队成员、嘉宾或合作机构时,把 2 到 5 个实体做成**竖排**胶囊名牌逐条滑入。chips 用换行分条(不是竖线),每条格式为 `dark 或 light|姓名|头衔`;右侧可另加 note 分类旁注。单人出镜讲解用 focus-card。",
  tags: ["人物","机构","名牌","实体"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    ...hudDefaults,
    position: "left",
    chips: "dark|张三|创始人\nlight|李四|技术总监",
    note: "核心团队|Core Team",
    stepMs: 150,
  },
  controls: [
    ...hudControls,
    { key: "chips", label: "名牌(牌面|名|身份,换行)", type: "text" },
    { key: "note", label: "旁注(上行|下行)", type: "text" },
    { key: "stepMs", label: "间隔(ms)", type: "number" },
  ],
  parts: [
    { id: "chips", label: "名牌", role: "list", params: ["chips", "stepMs"], enterMs: 0, settleMs: 1 * 150 + 600 },
    { id: "note", label: "旁注", role: "text", params: ["note"], enterMs: 2 * 150 + 200, settleMs: 2 * 150 + 200 + 600 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  timing: (p) => {
    const count = Math.max(1, p.chips.split("\n").filter(Boolean).length);
    const chips = (count - 1) * p.stepMs + 600;
    const hasNote = (p.note || "").split("|").filter(Boolean).length > 0;
    const noteEnter = count * p.stepMs + 200;
    return {
      settleMs: hasNote ? noteEnter + 600 : chips,
      parts: { chips: { settleMs: chips }, note: { enterMs: noteEnter, settleMs: hasNote ? noteEnter + 600 : noteEnter } },
    };
  },
  Component: EntityChipsCard,
};
